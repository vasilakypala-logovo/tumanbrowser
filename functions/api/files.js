
const MAX_FILE_SIZE = 45 * 1024 * 1024;
const DEFAULT_BUCKET = "tuman-files";

function json(data, status) {
  return new Response(JSON.stringify(data), {
    status: status || 200,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff"
    }
  });
}

function sameOrigin(request) {
  const origin = request.headers.get("Origin");
  if (!origin) return true;

  try {
    return new URL(request.url).origin === origin;
  } catch (_) {
    return false;
  }
}

function authorized(request, env) {
  const expected = env.TUMAN_ACCESS_CODE;
  const supplied = request.headers.get("X-Tuman-Key") || "";

  return typeof expected === "string" &&
    expected.length >= 20 &&
    supplied.length === expected.length &&
    supplied === expected;
}

function getConfig(env) {
  const base = String(env.SUPABASE_URL || "").replace(/\/+$/, "");
  const key = env.SUPABASE_SECRET_KEY ||
    env.SUPABASE_SERVICE_ROLE_KEY || "";
  const bucket = String(
    env.TUMAN_FILES_BUCKET || DEFAULT_BUCKET
  ).trim();

  if (!/^https:\/\/[a-z0-9.-]+$/i.test(base)) {
    throw new Error(
      "Не настроен SUPABASE_URL в Cloudflare Pages."
    );
  }

  if (typeof key !== "string" || key.length < 20) {
    throw new Error(
      "Добавь SUPABASE_SECRET_KEY в Cloudflare Pages."
    );
  }

  if (!/^[a-z0-9][a-z0-9_-]{1,61}[a-z0-9]$/.test(bucket)) {
    throw new Error("Неверное имя файлового хранилища.");
  }

  const headers = {
    "apikey": key,
    "Accept": "application/json"
  };

  if (!key.startsWith("sb_secret_")) {
    headers["Authorization"] = "Bearer " + key;
  }

  return {
    base: base,
    bucket: bucket,
    headers: headers
  };
}

async function errorText(response) {
  const copy = response.clone();

  try {
    const data = await copy.json();
    return data.message || data.error || data.msg ||
      "HTTP " + response.status;
  } catch (_) {
    try {
      return (await copy.text()).slice(0, 300) ||
        "HTTP " + response.status;
    } catch (_) {
      return "HTTP " + response.status;
    }
  }
}

async function ensureBucket(cfg) {
  const url = cfg.base + "/storage/v1/bucket";

  const listResponse = await fetch(url, {
    headers: cfg.headers
  });

  if (!listResponse.ok) {
    throw new Error(
      "Не удалось проверить Supabase Storage: " +
      await errorText(listResponse)
    );
  }

  const buckets = await listResponse.json();

  if (
    Array.isArray(buckets) &&
    buckets.some(function(item) {
      return item && item.id === cfg.bucket;
    })
  ) {
    return;
  }

  const response = await fetch(url, {
    method: "POST",
    headers: Object.assign({}, cfg.headers, {
      "Content-Type": "application/json"
    }),
    body: JSON.stringify({
      id: cfg.bucket,
      name: cfg.bucket,
      public: false,
      file_size_limit: MAX_FILE_SIZE
    })
  });

  if (response.ok) return;

  const verify = await fetch(url, {
    headers: cfg.headers
  });

  if (verify.ok) {
    const current = await verify.json();

    if (
      Array.isArray(current) &&
      current.some(function(item) {
        return item && item.id === cfg.bucket;
      })
    ) {
      return;
    }
  }

  throw new Error(
    "Не удалось создать закрытое хранилище: " +
    await errorText(response)
  );
}

/* Новые имена файлов храним в ASCII-совместимом формате. */

function encodeFileName(value) {
  const bytes = new TextEncoder().encode(String(value || "file"));
  let binary = "";

  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }

  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function decodeFileName(value) {
  try {
    let base64 = String(value || "")
      .replace(/-/g, "+")
      .replace(/_/g, "/");

    base64 += "=".repeat((4 - base64.length % 4) % 4);

    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);

    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }

    const decoded = new TextDecoder("utf-8", {
      fatal: true
    }).decode(bytes);

    return decoded || null;
  } catch (_) {
    return null;
  }
}

function safeOriginalName(value) {
  let name = String(value || "файл")
    .replace(/[\u0000-\u001f\u007f/\\]/g, "_")
    .replace(/^\.+/, "")
    .trim();

  if (!name) name = "файл";

  return Array.from(name).slice(0, 120).join("");
}

function originalNameFromKey(key) {
  const match = /^([0-9a-f-]{36})__(.*)$/i.exec(
    String(key || "")
  );

  if (!match || !match[2]) {
    return String(key || "файл");
  }

  const suffix = match[2];

  if (suffix.startsWith("b64_")) {
    const decoded = decodeFileName(suffix.slice(4));
    if (decoded) return decoded;
  }

  // Совместимость со старыми ASCII-именами.
  return suffix;
}

function makeObjectKey(name) {
  return crypto.randomUUID() + "__b64_" + encodeFileName(name);
}

function validKey(key) {
  if (typeof key !== "string" || key.length > 900) {
    return false;
  }

  // Новые ключи.
  if (/^[0-9a-f-]{36}__b64_[A-Za-z0-9_-]+$/i.test(key)) {
    return true;
  }

  // Старые ключи с латинскими именами.
  if (!/^[0-9a-f-]{36}__/.test(key)) {
    return false;
  }

  const oldName = key.slice(38);

  return oldName.length > 0 &&
    oldName.length <= 180 &&
    /^[\x20-\x7E]+$/.test(oldName) &&
    !/[\\/]/.test(oldName) &&
    oldName.trim() === oldName &&
    oldName.charAt(0) !== ".";
}

function encodeObjectPath(path) {
  return String(path)
    .split("/")
    .map(encodeURIComponent)
    .join("/");
}

async function onGet(request, env) {
  if (!sameOrigin(request)) {
    return json({
      error: "Запрос с другого сайта запрещён."
    }, 403);
  }

  if (!authorized(request, env)) {
    return json({
      error: "Код доступа не принят."
    }, 401);
  }

  let cfg;

  try {
    cfg = getConfig(env);
    await ensureBucket(cfg);
  } catch (error) {
    return json({
      error: error.message || "Не удалось подключить Обитель."
    }, 503);
  }

  const url = new URL(request.url);
  const action = url.searchParams.get("action") || "list";

  if (action === "list") {
    try {
      const response = await fetch(
        cfg.base + "/storage/v1/object/list/" +
        encodeURIComponent(cfg.bucket),
        {
          method: "POST",
          headers: Object.assign({}, cfg.headers, {
            "Content-Type": "application/json"
          }),
          body: JSON.stringify({
            prefix: "",
            limit: 200,
            offset: 0,
            sortBy: {
              column: "created_at",
              order: "desc"
            }
          })
        }
      );

      if (!response.ok) {
        return json({
          error: "Не удалось получить список файлов: " +
            await errorText(response)
        }, 502);
      }

      const raw = await response.json();

      const files = (Array.isArray(raw) ? raw : [])
        .filter(function(item) {
          return item &&
            typeof item.name === "string" &&
            typeof item.id === "string";
        })
        .map(function(item) {
          const meta = item.metadata || {};

          return {
            name: item.name,
            originalName: originalNameFromKey(item.name),
            size: Number(meta.size || meta.contentLength || 0),
            type: String(
              meta.mimetype ||
              meta.contentType ||
              "application/octet-stream"
            ),
            createdAt: item.created_at ||
              item.updated_at || null
          };
        });

      return json({
        ok: true,
        bucket: cfg.bucket,
        files: files
      });
    } catch (error) {
      return json({
        error: "Ошибка списка файлов: " +
          (error.message || "сетевая ошибка")
      }, 502);
    }
  }

  if (action === "download") {
    const key = url.searchParams.get("name") || "";

    if (!validKey(key)) {
      return json({
        error: "Неверное имя файла."
      }, 400);
    }

    try {
      const response = await fetch(
        cfg.base + "/storage/v1/object/" +
        encodeURIComponent(cfg.bucket) + "/" +
        encodeObjectPath(key),
        { headers: cfg.headers }
      );

      if (!response.ok) {
        return json({
          error: "Не удалось скачать файл: " +
            await errorText(response)
        }, 502);
      }

      const filename = originalNameFromKey(key);
      const headers = new Headers();

      headers.set(
        "Content-Type",
        response.headers.get("Content-Type") ||
          "application/octet-stream"
      );

      headers.set(
        "Content-Disposition",
        "attachment; filename*=UTF-8''" +
          encodeURIComponent(filename)
      );

      headers.set("Cache-Control", "no-store");
      headers.set("X-Content-Type-Options", "nosniff");

      const length = response.headers.get("Content-Length");
      if (length) headers.set("Content-Length", length);

      return new Response(response.body, {
        status: 200,
        headers: headers
      });
    } catch (error) {
      return json({
        error: "Ошибка скачивания: " +
          (error.message || "сетевая ошибка")
      }, 502);
    }
  }

  return json({
    error: "Неизвестное действие."
  }, 400);
}

async function onDelete(request, env) {
  if (!sameOrigin(request)) {
    return json({
      error: "Запрос с другого сайта запрещён."
    }, 403);
  }

  if (!authorized(request, env)) {
    return json({
      error: "Код доступа не принят."
    }, 401);
  }

  const url = new URL(request.url);
  const key = url.searchParams.get("name") || "";

  if (!validKey(key)) {
    return json({
      error: "Неверное имя файла. Удаление отменено."
    }, 400);
  }

  let cfg;

  try {
    cfg = getConfig(env);
    await ensureBucket(cfg);
  } catch (error) {
    return json({
      error: error.message || "Не удалось подключить Обитель."
    }, 503);
  }

  try {
    const response = await fetch(
      cfg.base + "/storage/v1/object/" +
      encodeURIComponent(cfg.bucket),
      {
        method: "DELETE",
        headers: Object.assign({}, cfg.headers, {
          "Content-Type": "application/json"
        }),
        body: JSON.stringify({
          prefixes: [key]
        })
      }
    );

    if (!response.ok) {
      return json({
        error: "Supabase не удалил файл: " +
          await errorText(response)
      }, 502);
    }

    return json({
      ok: true,
      deleted: key
    });
  } catch (error) {
    return json({
      error: "Ошибка удаления: " +
        (error.message || "сетевая ошибка")
    }, 502);
  }
}

async function onPost(request, env) {
  if (!sameOrigin(request)) {
    return json({
      error: "Запрос с другого сайта запрещён."
    }, 403);
  }

  if (!authorized(request, env)) {
    return json({
      error: "Код доступа не принят."
    }, 401);
  }

  const contentType = request.headers.get("Content-Type") || "";

  if (!contentType.toLowerCase().includes("multipart/form-data")) {
    return json({
      error: "Ожидается загрузка файла через форму."
    }, 415);
  }

  let form;

  try {
    form = await request.formData();
  } catch (_) {
    return json({
      error: "Не удалось прочитать загружаемый файл."
    }, 400);
  }

  const file = form.get("file");

  if (
    !file ||
    typeof file === "string" ||
    typeof file.stream !== "function"
  ) {
    return json({ error: "Файл не найден." }, 400);
  }

  if (file.size < 1) {
    return json({ error: "Пустой файл." }, 400);
  }

  if (file.size > MAX_FILE_SIZE) {
    return json({
      error: "На первом этапе предел — 45 МиБ на один файл."
    }, 413);
  }

  const name = safeOriginalName(file.name);
  const key = makeObjectKey(name);

  let cfg;

  try {
    cfg = getConfig(env);
    await ensureBucket(cfg);
  } catch (error) {
    return json({
      error: error.message || "Не удалось подключить Обитель."
    }, 503);
  }

  try {
    const response = await fetch(
      cfg.base + "/storage/v1/object/" +
      encodeURIComponent(cfg.bucket) + "/" +
      encodeObjectPath(key),
      {
        method: "POST",
        headers: Object.assign({}, cfg.headers, {
          "Content-Type": file.type || "application/octet-stream",
          "x-upsert": "false",
          "cache-control": "3600"
        }),
        body: file
      }
    );

    if (!response.ok) {
      return json({
        error: "Supabase не принял файл: " +
          await errorText(response)
      }, 502);
    }

    return json({
      ok: true,
      file: {
        name: key,
        originalName: name,
        size: file.size,
        type: file.type || "application/octet-stream",
        createdAt: new Date().toISOString()
      }
    }, 201);
  } catch (error) {
    return json({
      error: "Ошибка загрузки: " +
        (error.message || "сетевая ошибка")
    }, 502);
  }
}

export async function onRequest(context) {
  const method = context.request.method.toUpperCase();

  if (method === "GET") {
    return onGet(context.request, context.env);
  }

  if (method === "DELETE") {
    return onDelete(context.request, context.env);
  }

  if (method === "POST") {
    return onPost(context.request, context.env);
  }

  return json({
    error: "Метод не поддерживается."
  }, 405);
}
