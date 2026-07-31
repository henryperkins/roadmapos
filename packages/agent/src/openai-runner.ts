import { Agent, run } from "@openai/agents";
import type { ZodObject, ZodRawShape } from "zod";

export interface StructuredRunResult<T> {
  value: T;
  traceId: string | null;
}

/**
 * The Agents SDK accepts a Zod object schema as its structured `outputType`. RoadmapOS domain
 * contracts that are unions or carry `superRefine` are validated by the caller after the run, so
 * this helper takes the object schema the SDK can serialize plus the authoritative parser.
 */
export async function runStructured<T>(input: {
  name: string;
  model: string;
  instructions: string;
  outputType: ZodObject<ZodRawShape>;
  parse: (value: unknown) => T;
  prompt: string;
}): Promise<StructuredRunResult<T>> {
  const agent = new Agent({
    name: input.name,
    model: input.model,
    instructions: input.instructions,
    outputType: input.outputType
  });
  const result = await run(agent, input.prompt);
  // The SDK types `finalOutput` optimistically from the schema; a run that produced no structured
  // output still surfaces here as nullish, so the guard is deliberately wider than the static type.
  const finalOutput: unknown = result.finalOutput;
  if (finalOutput === undefined || finalOutput === null) {
    throw new Error(`${input.name} returned no structured output`);
  }
  return {
    value: input.parse(finalOutput),
    traceId: null
  };
}
