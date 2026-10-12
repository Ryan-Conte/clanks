// A stand-in for llama-server, run under Node by the supervisor and manager tests. It speaks
// enough of the real server's CLI, log format and HTTP API for those tests, and nothing more.
//
// The supervisor passes llama-server a scrubbed environment, so tests configure this through a
// JSON file named by --fake-config, read at every launch:
//   devices    what --list-devices prints
//   failLoad   log an error and exit 1 instead of loading
//   loadMs     how long "loading" takes (default 100)
//   placement  gpu, partial or cpu: which buffers the log reports (default gpu)
//   argsFile   append each launch's arguments to this file, one JSON line each
import { appendFileSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';

const args = process.argv.slice(2);
const arg = (name) => {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
};
const configFile = arg('--fake-config');
const config = configFile ? JSON.parse(readFileSync(configFile, 'utf8')) : {};
const log = (msg, level = 'info') =>
  process.stdout.write(JSON.stringify({ type: 'log', time: 0, level, msg: msg + '\n' }) + '\n');

if (args.includes('--list-devices')) {
  process.stdout.write(config.devices ?? 'Available devices:\n  (none)\n');
  process.exit(0);
}

if (config.argsFile) appendFileSync(config.argsFile, JSON.stringify(args) + '\n');

log(`srv    load_model: loading model '${arg('--model')}'`);
if (config.failLoad) {
  log('llama_model_load: error loading model: out of memory', 'error');
  setTimeout(() => process.exit(1), 50);
} else {
  const port = Number(arg('--port'));
  const apiKey = arg('--api-key');
  const alias = arg('--alias');
  let loaded = false;

  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/health') {
      res.writeHead(loaded ? 200 : 503, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ status: loaded ? 'ok' : 'loading model' }));
      return;
    }
    if (req.headers.authorization !== `Bearer ${apiKey}`) {
      res.writeHead(401).end(JSON.stringify({ error: { message: 'Invalid API Key' } }));
      return;
    }
    if (url.pathname === '/props') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ model_alias: alias, chat_template_caps: { supports_tools: true } }));
      return;
    }
    if (url.pathname === '/v1/chat/completions' && req.method === 'POST') {
      let raw = '';
      req.on('data', (data) => (raw += data));
      req.on('end', () => chat(JSON.parse(raw), res));
      return;
    }
    res.writeHead(404).end();
  });
  server.listen(port, '127.0.0.1');

  setTimeout(
    () => {
      const placement = config.placement ?? 'gpu';
      const gpuLayers = placement === 'gpu' ? 7 : placement === 'partial' ? 3 : 0;
      log(`load_tensors: offloaded ${gpuLayers}/7 layers to GPU`);
      log('load_tensors:   CPU_Mapped model buffer size =    17.50 MiB');
      if (placement !== 'cpu') {
        log('load_tensors:      CUDA0 model buffer size =   500.00 MiB');
        log('llama_kv_cache:      CUDA0 KV buffer size =    96.00 MiB');
        log('sched_reserve:      CUDA0 compute buffer size =    44.00 MiB');
      } else {
        log('llama_kv_cache:        CPU KV buffer size =    96.00 MiB');
      }
      log('srv  llama_server: model loaded');
      loaded = true;
    },
    Number(config.loadMs ?? 100),
  );
}

function chat(body, res) {
  const last = [...body.messages].reverse().find((m) => m.role === 'user')?.content ?? '';
  if (last === 'crash') process.exit(3);
  const words = `echo: ${last}`.split(/(?= )/);
  const usage = {
    prompt_tokens: 5,
    completion_tokens: words.length,
    total_tokens: 5 + words.length,
  };
  const timings = { prompt_per_second: 500, predicted_per_second: 120 };
  const base = { id: 'chatcmpl-1', object: 'chat.completion.chunk', model: body.model, created: 0 };
  if (!body.stream) {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        ...base,
        object: 'chat.completion',
        choices: [
          {
            index: 0,
            finish_reason: 'stop',
            message: { role: 'assistant', content: words.join('') },
          },
        ],
        usage,
        timings,
      }),
    );
    return;
  }
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  const send = (data) => res.write(`data: ${JSON.stringify({ ...base, ...data })}\n\n`);
  const choice = (delta, finish = null) =>
    send({ choices: [{ index: 0, delta, finish_reason: finish }] });
  choice({ role: 'assistant', content: null });
  for (const word of words) choice({ content: word });
  choice({}, 'stop');
  send({ choices: [], usage, timings });
  res.end('data: [DONE]\n\n');
}
