const MODEL = "@cf/zai-org/glm-4.7-flash";

function isSameOrigin(request) {
  const origin = request.headers.get("Origin");

  if (!origin) return false;

  try {
    return new URL(request.url).origin === origin;
  } catch (_) {
    return false;
  }
}

function json(data, status, request) {
  const headers = {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff"
  };

  if (isSameOrigin(request)) {
    headers["Access-Control-Allow-Origin"] =
      request.headers.get("Origin");
    headers["Vary"] = "Origin";
  }

  return new Response(JSON.stringify(data), {
    status: status || 200,
    headers
  });
}

function extractText(value) {
  if (typeof value === "string") {
    return value.trim();
  }

  if (Array.isArray(value)) {
    return value.map(function(part) {
      if (typeof part === "string") return part;

      if (part && typeof part.text === "string") {
        return part.text;
      }

      return "";
    }).join("").trim();
  }

  return "";
}

export function onRequestOptions({ request }) {
  if (!isSameOrigin(request)) {
    return new Response(null, { status: 403 });
  }

  return new Response(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": request.headers.get("Origin"),
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, X-Tuman-Key",
      "Access-Control-Max-Age": "600",
      "Vary": "Origin"
    }
  });
}

export async function onRequestPost({ request, env }) {
  if (!isSameOrigin(request)) {
    return json({
      error: "Открой https://tumanbrowser.pages.dev/ и повтори попытку."
    }, 403, request);
  }

  const accessCode = env.TUMAN_ACCESS_CODE;

  if (typeof accessCode !== "string" || accessCode.length < 20) {
    return json({
      error: "Не настроен TUMAN_ACCESS_CODE. Проверь секрет в Production и повторное развёртывание."
    }, 503, request);
  }

  const suppliedCode = request.headers.get("X-Tuman-Key") || "";

  if (
    suppliedCode.length !== accessCode.length ||
    suppliedCode !== accessCode
  ) {
    return json({
      error: "Код доступа не принят. Проверь код в Cloudflare."
    }, 401, request);
  }

  if (!env.AI || typeof env.AI.run !== "function") {
    return json({
      error: "Не подключена привязка Workers AI с именем AI."
    }, 503, request);
  }

  const contentType = request.headers.get("Content-Type") || "";

  if (!contentType.toLowerCase().includes("application/json")) {
    return json({
      error: "Ожидается JSON-запрос."
    }, 415, request);
  }

  let raw;

  try {
    raw = await request.text();
  } catch (_) {
    return json({
      error: "Не удалось прочитать запрос."
    }, 400, request);
  }

  if (raw.length > 14000) {
    return json({
      error: "Запрос слишком большой. Сократи историю диалога."
    }, 413, request);
  }

  let body;

  try {
    body = JSON.parse(raw);
  } catch (_) {
    return json({
      error: "Не удалось разобрать запрос."
    }, 400, request);
  }

  if (
    !body ||
    !Array.isArray(body.messages) ||
    body.messages.length < 1 ||
    body.messages.length > 8
  ) {
    return json({
      error: "Передай от 1 до 8 последних реплик."
    }, 400, request);
  }

  const messages = [];
  let totalChars = 0;

  for (const item of body.messages) {
    if (
      !item ||
      (item.role !== "user" && item.role !== "assistant") ||
      typeof item.content !== "string"
    ) {
      return json({
        error: "Неверный формат истории диалога."
      }, 400, request);
    }

    const content = item.content.trim();

    if (!content || content.length > 3500) {
      return json({
        error: "Одна из реплик пуста или слишком длинная."
      }, 400, request);
    }

    totalChars += content.length;

    messages.push({
      role: item.role,
      content: content
    });
  }

  if (
    totalChars > 11000 ||
    messages[messages.length - 1].role !== "user"
  ) {
    return json({
      error: "История слишком велика или последнее сообщение не от пользователя."
    }, 400, request);
  }

  const systemPrompt =
    "Ты — отдельный облачный ИИ-помощник проекта «Морда Тумана», " +
    "создаваемого Василием Михайловичем. " +
    "Отвечай по-русски, если пользователь не выбрал другой язык. " +
    "Будь дружелюбным, творческим, практичным и честным. " +
    "Помогай разрабатывать идеи, решать задачи и создавать проекты. " +
    "Не выдумывай факты, результаты проверок или выполненные действия. " +
    "Не утверждай, что имеешь доступ к файлам, сайтам или истории " +
    "других чатов, если они не переданы в запросе. " +
    "Ты отдельный облачный ИИ, а не ChatGPT, и не обладаешь его памятью. " +
    "При действиях, способных повлечь расходы или потерю данных, " +
    "сначала объясняй последствия. Не раскрывай секреты доступа.";

  try {
    const result = await env.AI.run(MODEL, {
      messages: [
        { role: "system", content: systemPrompt },
        ...messages
      ],
      max_tokens: 420,
      temperature: 0.65,
      reasoning_effort: "low",
      chat_template_kwargs: {
        enable_thinking: false
      }
    });

    let answer = "";

    // Основной формат Workers AI для GLM:
    // choices[0].message.content
    if (result && Array.isArray(result.choices)) {
      for (const choice of result.choices) {
        if (!choice || !choice.message) continue;

        answer = extractText(choice.message.content);

        if (answer) break;
      }
    }

    // Дополнительные форматы ответа.
    if (!answer && result) {
      answer = extractText(result.response);
    }

    if (!answer && result && result.result) {
      const nested = result.result;

      if (Array.isArray(nested.choices)) {
        for (const choice of nested.choices) {
          if (!choice || !choice.message) continue;

          answer = extractText(choice.message.content);

          if (answer) break;
        }
      }

      if (!answer) {
        answer = extractText(nested.response);
      }
    }

    if (!answer && result) {
      answer = extractText(result.output_text);
    }

    if (!answer && result) {
      answer = extractText(result.text);
    }

    if (!answer) {
      const fields = result && typeof result === "object"
        ? Object.keys(result).join(", ")
        : typeof result;

      return json({
        error:
          "Cloudflare вызвал модель, но текст ответа не найден. " +
          "Полученные поля: " + (fields || "нет данных") +
          ". Это поможет определить формат ответа."
      }, 502, request);
    }

    return json({
      answer: answer,
      model: MODEL
    }, 200, request);

  } catch (_) {
    return json({
      error:
        "Ошибка вызова Workers AI. Проверь доступность модели, " +
        "настройки Cloudflare и квоту."
    }, 502, request);
  }
}
