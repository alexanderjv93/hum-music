// Server side of the app. The browser only ever talks to these routes, so the
// Suno API key stays in Netlify's environment and never reaches the client.
//
//   GET  /api/config            whether an access code is required
//   POST /api/generate          start a music task
//   GET  /api/generate/:taskId  music task status
//   POST /api/lyrics            start a lyrics task
//   GET  /api/lyrics/:taskId    lyrics task status
//   POST /api/callback          required by Suno; the app polls, so it is a no-op

const SUNO = "https://api.sunoapi.org/api/v1";
const MODELS = new Set(["V6", "V6_WILD", "V6_MINI"]);
const LIMITS = { prompt: 3000, style: 1000, lyrics: 5000, negativeTags: 1000, title: 80 };

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });

class BadRequest extends Error {}

function text(body, field) {
  const value = body[field];
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string") throw new BadRequest(`${field} must be text.`);
  const trimmed = value.trim();
  if (trimmed.length > LIMITS[field]) {
    throw new BadRequest(`${field} is limited to ${LIMITS[field]} characters.`);
  }
  return trimmed || undefined;
}

// Builds the Suno payload from an allowlist of fields, following the rules in
// https://docs.sunoapi.org/suno-api/generate-music: some fields are rejected
// outside custom mode, so they are only sent when customMode is true.
function musicPayload(body, callBackUrl) {
  const customMode = body.customMode === true;
  const instrumental = body.instrumental === true;
  const model = MODELS.has(body.model) ? body.model : "V6";
  const payload = { customMode, instrumental, model, callBackUrl };

  if (!customMode) {
    const prompt = text(body, "prompt");
    const style = text(body, "style");
    if (!prompt && !style) throw new BadRequest("Describe the song you want first.");
    return { ...payload, prompt, style };
  }

  const style = text(body, "style");
  const lyrics = instrumental ? undefined : text(body, "lyrics");
  const negativeTags = text(body, "negativeTags");
  if (!style && !lyrics && !negativeTags) {
    throw new BadRequest("Add a style or some lyrics first.");
  }

  const duration = Number(body.duration);
  return {
    ...payload,
    style,
    lyrics,
    negativeTags,
    title: text(body, "title"),
    vocalGender: !instrumental && ["m", "f"].includes(body.vocalGender) ? body.vocalGender : undefined,
    // Suno defaults to a 20 second clip in custom mode unless told otherwise.
    duration: Number.isFinite(duration) ? Math.min(360, Math.max(10, Math.round(duration))) : 120,
  };
}

async function suno(path, init = {}) {
  const res = await fetch(`${SUNO}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${process.env.SUNO_API_KEY}`,
      "content-type": "application/json",
    },
  });
  const data = await res.json().catch(() => null);
  if (!data) return json({ error: "The music service sent an unreadable response." }, 502);
  if (data.code !== 200) return json({ error: friendlyError(data.code, data.msg) }, 502);
  return json({ data: data.data });
}

// Suno reports failures in the body's `code`. Account-level problems are
// reworded so visitors never see details about the owner's account.
function friendlyError(code, msg) {
  switch (code) {
    case 400:
    case 413:
      return msg || "That request wasn't accepted. Try rewording it.";
    case 401:
    case 429:
      return "The app can't generate music right now. Please try again later.";
    case 405:
    case 430:
      return "Too many requests at once. Wait a moment and try again.";
    case 455:
      return "The music service is down for maintenance. Try again soon.";
    default:
      return "The music service had a problem. Please try again.";
  }
}

export default async (req) => {
  const url = new URL(req.url);
  const [, , resource, id] = url.pathname.split("/");
  const accessCode = process.env.ACCESS_CODE;

  if (resource === "callback") return json({ status: "received" });
  if (resource === "config") return json({ accessRequired: Boolean(accessCode) });

  if (!process.env.SUNO_API_KEY) {
    return json({ error: "SUNO_API_KEY isn't set in Netlify's environment variables." }, 500);
  }
  if (accessCode && req.headers.get("x-access-code") !== accessCode) {
    return json({ error: "That access code isn't right.", accessDenied: true }, 401);
  }

  try {
    if (resource === "generate" || resource === "lyrics") {
      if (req.method === "GET" && id) {
        if (!/^[\w-]+$/.test(id)) throw new BadRequest("Invalid task ID.");
        const info = resource === "generate" ? "generate/record-info" : "lyrics/record-info";
        return await suno(`/${info}?taskId=${id}`);
      }
      if (req.method === "POST" && !id) {
        const body = await req.json().catch(() => null);
        if (!body || typeof body !== "object") throw new BadRequest("Invalid request.");
        const callBackUrl = `${url.origin}/api/callback`;

        if (resource === "generate") {
          return await suno("/generate", {
            method: "POST",
            body: JSON.stringify(musicPayload(body, callBackUrl)),
          });
        }
        const prompt = text(body, "prompt");
        if (!prompt) throw new BadRequest("Describe what the lyrics should be about.");
        return await suno("/lyrics", {
          method: "POST",
          body: JSON.stringify({ prompt: prompt.slice(0, 200), callBackUrl }),
        });
      }
    }
    return json({ error: "Not found." }, 404);
  } catch (err) {
    if (err instanceof BadRequest) return json({ error: err.message }, 400);
    console.error(err);
    return json({ error: "Couldn't reach the music service. Please try again." }, 502);
  }
};

export const config = { path: "/api/*" };
