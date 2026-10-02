const providers = [
  { id: 'openai', name: 'OpenAI', apiType: 'openai-compatible', baseUrl: 'https://api.openai.com/v1', models: [{ id: 'gpt-4o-mini', label: 'GPT-4o mini', supportsVision: true, supportsStreaming: true }, { id: 'gpt-4o', label: 'GPT-4o', supportsVision: true, supportsStreaming: true }] },
  { id: 'deepseek', name: 'DeepSeek', apiType: 'openai-compatible', baseUrl: 'https://api.deepseek.com/v1', models: [{ id: 'deepseek-chat', label: 'DeepSeek Chat', supportsStreaming: true }, { id: 'deepseek-reasoner', label: 'DeepSeek Reasoner', supportsReasoning: true, supportsStreaming: true }] },
  { id: 'anthropic', name: 'Anthropic Claude', apiType: 'anthropic', baseUrl: 'https://api.anthropic.com/v1', models: [{ id: 'claude-3-5-sonnet-latest', label: 'Claude 3.5 Sonnet', supportsVision: true, supportsStreaming: true }, { id: 'claude-3-5-haiku-latest', label: 'Claude 3.5 Haiku', supportsStreaming: true }] },
  { id: 'gemini', name: 'Google Gemini', apiType: 'gemini', baseUrl: 'https://generativelanguage.googleapis.com/v1beta', models: [{ id: 'gemini-2.0-flash', label: 'Gemini 2.0 Flash', supportsVision: true, supportsStreaming: true }, { id: 'gemini-1.5-pro', label: 'Gemini 1.5 Pro', supportsVision: true, supportsStreaming: true }] },
  { id: 'openrouter', name: 'OpenRouter', apiType: 'openai-compatible', baseUrl: 'https://openrouter.ai/api/v1', models: [{ id: 'openai/gpt-4o-mini', label: 'OpenAI GPT-4o mini', supportsVision: true, supportsStreaming: true }, { id: 'deepseek/deepseek-chat', label: 'DeepSeek Chat', supportsStreaming: true }] },
  { id: 'siliconflow', name: 'SiliconFlow', apiType: 'openai-compatible', baseUrl: 'https://api.siliconflow.cn/v1', models: [{ id: 'Qwen/Qwen2.5-72B-Instruct', label: 'Qwen 2.5 72B', supportsStreaming: true }, { id: 'deepseek-ai/DeepSeek-V3', label: 'DeepSeek V3', supportsStreaming: true }] },
  { id: 'moonshot', name: 'Moonshot / Kimi', apiType: 'openai-compatible', baseUrl: 'https://api.moonshot.cn/v1', models: [{ id: 'moonshot-v1-8k', label: 'Moonshot v1 8K', supportsStreaming: true }, { id: 'moonshot-v1-32k', label: 'Moonshot v1 32K', supportsStreaming: true }] },
  { id: 'zhipu', name: 'Zhipu / GLM', apiType: 'openai-compatible', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', models: [{ id: 'glm-4-flash', label: 'GLM-4-Flash', supportsStreaming: true }, { id: 'glm-4-plus', label: 'GLM-4-Plus', supportsStreaming: true }] },
  { id: 'qwen', name: 'Qwen / DashScope', apiType: 'openai-compatible', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', models: [{ id: 'qwen-plus', label: 'Qwen Plus', supportsStreaming: true }, { id: 'qwen-turbo', label: 'Qwen Turbo', supportsStreaming: true }] },
  { id: 'ollama', name: 'Ollama / Local', apiType: 'openai-compatible', baseUrl: 'http://127.0.0.1:11434/v1', models: [{ id: 'llama3.2', label: 'Llama 3.2', supportsStreaming: true }, { id: 'qwen2.5', label: 'Qwen 2.5', supportsStreaming: true }] },
  { id: 'mathpix', name: 'Mathpix Math OCR', apiType: 'mathpix', baseUrl: 'https://api.mathpix.com/v3', models: [{ id: 'mathpix-text', label: 'Mathpix Text + LaTeX OCR', supportsMathOCR: true }] },
  { id: 'custom', name: 'Custom / OpenAI-Compatible', apiType: 'openai-compatible', baseUrl: '', models: [] }
];

function getProvider(id) { return providers.find(provider => provider.id === id) || providers.find(provider => provider.id === 'custom'); }
function fallbackModels(id) { return getProvider(id).models || []; }
function publicProviders() { return providers.map(({ id, name, apiType, baseUrl, models }) => ({ id, name, apiType, baseUrl, models })); }

module.exports = { providers, getProvider, fallbackModels, publicProviders };
