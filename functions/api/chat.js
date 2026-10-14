const MODEL = "@cf/zai-org/glm-4.7-flash";

function isSameOrigin(request) {
  const origin = request.headers.get("Origin");

  if (!origin) {
    return false;
  }

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
      error: "Запрос должен поступать с того же сайта. Открой https://tumanbrowser.pages.dev/ и повтори попытку."
    }, 403, request);
  }

  const accessCode = env.TUMAN_ACCESS_CODE;

  if (typeof accessCode !== "string" || accessCode.length < 20) {
    return json({
      error: "Не настроен секрет TUMAN_ACCESS_CODE. Проверь Production в настройках Cloudflare Pages и выполни повторное развёртывание."
    }, 503, request);
  }

  const suppliedCode = request.headers.get("X-Tuman-Key") || "";

  if (
    suppliedCode.length !== accessCode.length ||
    suppliedCode !== accessCode
  ) {
    return json({
      error: "Код доступа не принят. Проверь код, сохранённый в Cloudflare."
    }, 401, request);
  }

  if (!env.AI || typeof env.AI.run !== "function") {
    return json({
      error: "Нет привязки Workers AI. В Cloudflare Pages добавь AI binding с именем AI и повторно разверни сайт."
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
    "Не утверждай, что у тебя есть доступ к файлам, сайтам или памяти " +
    "других чатов, если они не переданы в запросе. " +
    "Ты отдельный облачный ИИ, а не ChatGPT, и не обладаешь его памятью. " +
    "Если действие может повлечь расходы, потерю данных или изменение " +
    "внешних систем, сначала объясняй последствия. " +
    "Не раскрывай секреты доступа и не проси передавать пароли.";

  try {
    const result = await env.AI.run(MODEL, {
      messages: [
        { role: "system", content: systemPrompt },
        ...messages
      ],
      max_tokens: 420,
      temperature: 0.65
    });

    let answer = "";

    if (result && typeof result.response === "string") {
      answer = result.response;
    } else if (
      result &&
      result.result &&
      typeof result.result.response === "string"
    ) {
      answer = result.result.response;
    } else if (
      result &&
      typeof result.output_text === "string"
    ) {
      answer = result.output_text;
    } else if (
      result &&
      typeof result.text === "string"
    ) {
      answer = result.text;
    }

    if (!answer.trim()) {
      return json({
        error: "Модель вернула пустой ответ. Проверь доступность модели и квоту Cloudflare."
      }, 502, request);
    }

    return json({
      answer: answer.trim(),
      model: MODEL
    }, 200, request);

  } catch (_) {
    return json({
      error: "Облачный ИИ не ответил. Проверь привязку AI, модель и квоту Cloudflare."
    }, 502, request);
  }
}
