# Models

clanks downloads open models and runs them itself. You don't need Ollama, a model server or a command line.

## Pulling a model

**Models** in the sidebar lists the models clanks recommends, each with whether it fits your machine: on the graphics card, partly on it, or too large. **Pull** downloads one. A download can be paused, survives a restart, and is checked by its sha256 before it's used.

You can also pull any model published as GGUF on Hugging Face, by typing `hf.co/<owner>/<repo>:<quant>`. If you already have models from Ollama on disk, clanks can reuse those files instead of downloading them again.

## How they run

A model loads when a clank first needs it and unloads after ten minutes idle, unless you keep it loaded. Several clanks share one loaded model, each in a slot of its own. A ticket whose model is busy waits and says so on its card, such as "Waiting for gemma4:26b: its 2 slots are busy".

Settings → Running models changes how long a model stays loaded, how much context each slot gets, how many slots a model has, and how much memory models may use.

## What to expect from a local model

A small local model gets real work done, more slowly and more plainly than a frontier model would. clanks is built around that: it tells the model the facts up front, checks what it hands in, and sends work back rather than failing a ticket. A model that can see pictures helps Prism and Gauge, who can then look at what they made.

## Cloud models and your own servers

Both are optional.

- **Cloud:** paste a key for Anthropic, OpenAI, Google or OpenRouter in Settings. It's kept in your operating system's keychain and goes only to that provider. Give a model to one clank, such as Atlas, or to a whole project.
- **Your own server:** anything that speaks the OpenAI API, such as vLLM, LM Studio or Ollama, on this computer or another.

For budgets in money, tell Settings what each cloud provider charges per million tokens. Local models cost nothing.

## Serving your models to other apps

Settings → Local API serves the models you've pulled to other apps on this computer, with OpenAI-style and Ollama-style endpoints on `127.0.0.1`. It's off unless you turn it on.
