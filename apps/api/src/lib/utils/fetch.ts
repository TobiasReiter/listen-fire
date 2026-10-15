import { logger } from 'movement-engine/services/logger';

async function parseJsonResponse(response: Response, serviceName: string): Promise<unknown> {
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    logger.error(`${serviceName} returned non-JSON response`, { status: response.status, body: text });
    throw new Error(`${serviceName} returned non-JSON response (${response.status}): ${text.slice(0, 200)}`);
  }
}

export { parseJsonResponse };
