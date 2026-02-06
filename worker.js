addEventListener('fetch', event => {
  event.respondWith(handleRequest(event.request));
});

const MODEL_MAPPING = {
  'gpt-3.5-turbo': 'nvidia/llama-3.1-nemotron-ultra-253b-v1',
  'gpt-4': 'qwen/qwen3-coder-480b-a35b-instruct',
  'gpt-4-turbo': 'moonshotai/kimi-k2-instruct-0905',
  'gpt-4o': 'deepseek-ai/deepseek-v3.1',
  'claude-3-opus': 'openai/gpt-oss-120b',
  'claude-3-sonnet': 'openai/gpt-oss-20b',
  'gemini-pro': 'qwen/qwen3-next-80b-a3b-thinking'
};

const DEFAULT_NIM_BASE = 'https://integrate.api.nvidia.com/v1';
const SHOW_REASONING = true;
const ENABLE_THINKING_MODE = true;

// Utility: CORS headers (adjust origin for production)
function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type,Authorization'
  };
}

async function handleRequest(request) {
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method.toUpperCase();

  // Handle preflight
  if (method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: corsHeaders()
    });
  }

  try {
    if (path === '/' && method === 'GET') {
      return jsonResponse(healthPayload(), 302, { Location: '/health' });
    }

    if (path === '/health' && method === 'GET') {
      return jsonResponse(healthPayload());
    }

    if (path === '/v1/health' && method === 'GET') {
      // Redirect to /health
      return new Response(null, {
        status: 302,
        headers: { ...corsHeaders(), Location: '/health' }
      });
    }

    if (path === '/v1/models' && method === 'GET') {
      const models = Object.keys(MODEL_MAPPING).map(m => ({
        id: m,
        object: 'model',
        created: Date.now(),
        owned_by: 'nvidia-nim-proxy'
      }));
      return jsonResponse({ object: 'list', data: models });
    }

    if (path === '/v1/chat/completions' && method === 'GET') {
      return jsonResponse({
        error: {
          message: 'Method GET not allowed on /v1/chat/completions. Use POST with OpenAI-compatible payload.',
          type: 'method_not_allowed',
          code: 405
        }
      }, 405);
    }

    if (path === '/v1/chat/completions' && method === 'POST') {
      const nimBase = (typeof NIM_API_BASE !== 'undefined' && NIM_API_BASE) ? NIM_API_BASE : DEFAULT_NIM_BASE;
      const nimKey = NIM_API_KEY; // NIM_API_KEY must be bound as a Worker secret
      if (!nimKey) {
        return jsonResponse({ error: { message: 'NIM_API_KEY not configured' } }, 500);
      }

      const body = await request.json().catch(() => ({}));
      const { model = '', messages = [], temperature, max_tokens, stream } = body;

      // Model mapping and fallback
      let nimModel = MODEL_MAPPING[model];
      if (!nimModel) {
        const modelLower = (model || '').toLowerCase();
        if (modelLower.includes('gpt-4') || modelLower.includes('claude-opus') || modelLower.includes('405b')) {
          nimModel = 'meta/llama-3.1-405b-instruct';
        } else if (modelLower.includes('claude') || modelLower.includes('gemini') || modelLower.includes('70b')) {
          nimModel = 'meta/llama-3.1-70b-instruct';
        } else {
          nimModel = 'meta/llama-3.1-8b-instruct';
        }
      }

      const nimRequestBody = {
        model: nimModel,
        messages: messages,
        temperature: typeof temperature !== 'undefined' ? temperature : 0.6,
        max_tokens: typeof max_tokens !== 'undefined' ? max_tokens : 9024,
        extra_body: ENABLE_THINKING_MODE ? { chat_template_kwargs: { thinking: true } } : undefined,
        stream: !!stream
      };

      // Forward request to NIM
      const nimResp = await fetch(`${nimBase}/chat/completions`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${nimKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(nimRequestBody)
      });

      // If streaming, pipe the body to the client (pass-through)
      if (stream) {
        // Worker: stream response body directly; set SSE-friendly headers
        const headers = new Headers();
        headers.set('Content-Type', 'text/event-stream');
        headers.set('Cache-Control', 'no-cache, no-transform');
        headers.set('X-Accel-Buffering', 'no');
        // Do not set Connection header here — Cloudflare manages connections
        // Add CORS
        Object.entries(corsHeaders()).forEach(([k, v]) => headers.set(k, v));

        // nimResp.body is a ReadableStream in Workers; return it directly
        return new Response(nimResp.body, {
          status: nimResp.status,
          headers
        });
      }

      // Non-streaming: transform NIM response into OpenAI-like response (best-effort)
      const nimJson = await nimResp.json().catch(() => null);
      if (!nimJson) {
        // Return raw text if can't parse
        const text = await nimResp.text().catch(() => '');
        return textResponse(text, nimResp.status);
      }

      // Map choices/messages to OpenAI format if possible
      const openaiResponse = {
        id: `chatcmpl-${Date.now()}`,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: model || nimJson.model || nimModel,
        choices: Array.isArray(nimJson.choices)
          ? nimJson.choices.map(choice => {
              // NIM might use choice.message.content or choice.message?.content etc.
              const content = choice.message?.content ?? choice.content ?? '';
              const reasoning = choice.message?.reasoning_content ?? choice.reasoning_content;
              let full = content;
              if (SHOW_REASONING && reasoning) {
                full = `<think>\n${reasoning}\n</think>\n\n${content}`;
              }
              return {
                index: choice.index ?? 0,
                message: {
                  role: choice.message?.role ?? 'assistant',
                  content: full
                },
                finish_reason: choice.finish_reason ?? null
              };
            })
          : [],
        usage: nimJson.usage ?? { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }
      };

      return jsonResponse(openaiResponse, nimResp.status);
    }

    // Catch-all
    return jsonResponse({
      error: { message: `Endpoint ${path} not found`, type: 'invalid_request_error', code: 404 }
    }, 404);
  } catch (err) {
    return jsonResponse({ error: { message: err.message || 'Internal server error' } }, 500);
  }
}

function jsonResponse(obj, status = 200, extraHeaders = {}) {
  const headers = {
    'Content-Type': 'application/json;charset=UTF-8',
    ...corsHeaders(),
    ...extraHeaders
  };
  return new Response(JSON.stringify(obj), { status, headers });
}

function textResponse(text = '', status = 200, extraHeaders = {}) {
  const headers = {
    'Content-Type': 'text/plain;charset=UTF-8',
    ...corsHeaders(),
    ...extraHeaders
  };
  return new Response(text, { status, headers });
}

function healthPayload() {
  return {
    status: 'ok',
    service: 'OpenAI to NVIDIA NIM Proxy (Cloudflare Worker)',
    reasoning_display: SHOW_REASONING,
    thinking_mode: ENABLE_THINKING_MODE
  };
}
