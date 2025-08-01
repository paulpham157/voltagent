import { Agent, VoltAgent } from "@voltagent/core";
import { createPinoLogger } from "@voltagent/logger";
import { VercelAIProvider } from "@voltagent/vercel-ai";

import { openai } from "@ai-sdk/openai";

const agent = new Agent({
  name: "Asistant",
  description: "A helpful assistant that answers questions without using tools",
  llm: new VercelAIProvider(),
  model: openai("gpt-4o-mini"),
});

// Create logger
const logger = createPinoLogger({
  name: "with-vercel-ai",
  level: "info",
});

new VoltAgent({
  agents: {
    agent,
  },
  logger,
});
