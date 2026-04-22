import { randomUUID } from "node:crypto";

function normalizeRole(role) {
  const normalized = String(role || "").trim().toLowerCase();
  return normalized || "user";
}

function extractImageUrlFromPart(part) {
  if (!part || typeof part !== "object") {
    return "";
  }
  if (part.type === "image_url") {
    if (typeof part.image_url === "string") {
      return part.image_url.trim();
    }
    if (part.image_url && typeof part.image_url === "object" && typeof part.image_url.url === "string") {
      return part.image_url.url.trim();
    }
  }
  if (part.type === "input_image") {
    if (typeof part.image_url === "string") {
      return part.image_url.trim();
    }
    if (typeof part.url === "string") {
      return part.url.trim();
    }
  }
  return "";
}

function extractTextFromPart(part) {
  if (!part || typeof part !== "object") {
    return "";
  }
  if (part.type === "text" && typeof part.text === "string") {
    return part.text;
  }
  if (part.type === "input_text" && typeof part.text === "string") {
    return part.text;
  }
  return "";
}

export function extractMessageParts(content) {
  if (typeof content === "string") {
    return {
      text: content.trim(),
      imageUrls: [],
    };
  }

  if (!Array.isArray(content)) {
    return {
      text: "",
      imageUrls: [],
    };
  }

  const texts = [];
  const imageUrls = [];
  for (const part of content) {
    const text = extractTextFromPart(part);
    if (text) {
      texts.push(text);
    }
    const imageUrl = extractImageUrlFromPart(part);
    if (imageUrl) {
      imageUrls.push(imageUrl);
    }
  }

  return {
    text: texts.join("").trim(),
    imageUrls,
  };
}

function serializeMessageForHistory(message) {
  const role = normalizeRole(message?.role);
  const { text, imageUrls } = extractMessageParts(message?.content);
  const historyRole = role === "assistant" ? "assistant" : "user";
  const segments = [];

  if (role === "system") {
    segments.push("[System]");
  } else if (role === "tool") {
    segments.push("[Tool]");
  }

  if (text) {
    segments.push(text);
  }

  if (imageUrls.length > 0) {
    segments.push(
      imageUrls.length === 1
        ? "[Attached image omitted from prior turn]"
        : `[${imageUrls.length} attached images omitted from prior turn]`,
    );
  }

  const content = segments.filter(Boolean).join("\n\n").trim();
  return content ? { role: historyRole, content } : null;
}

export function buildChatTurn(messages) {
  const normalizedMessages = Array.isArray(messages) ? messages : [];
  if (normalizedMessages.length === 0) {
    throw new Error("messages must be a non-empty array");
  }

  const history = [];
  for (const message of normalizedMessages.slice(0, -1)) {
    const entry = serializeMessageForHistory(message);
    if (entry) {
      history.push(entry);
    }
  }

  const lastMessage = normalizedMessages.at(-1);
  const lastRole = normalizeRole(lastMessage?.role);
  const { text, imageUrls } = extractMessageParts(lastMessage?.content);

  let promptText = text;
  if (lastRole === "system") {
    promptText = promptText ? `[System]\n\n${promptText}` : "[System]";
  } else if (lastRole === "assistant") {
    promptText = promptText ? `[Assistant]\n\n${promptText}` : "[Assistant]";
  } else if (lastRole === "tool") {
    promptText = promptText ? `[Tool]\n\n${promptText}` : "[Tool]";
  }

  if (!promptText && imageUrls.length > 0) {
    promptText = "Analyze the attached image.";
  }

  if (!promptText) {
    throw new Error("last message must include text or image content");
  }

  return {
    promptText,
    imageUrls,
    initialHistory: history,
  };
}

export function normalizeResponseFormat(responseFormat) {
  if (!responseFormat || responseFormat === "text") {
    return {
      type: "text",
      jsonSchema: null,
      outputFormat: null,
    };
  }

  if (typeof responseFormat !== "object") {
    throw new Error("response_format must be an object");
  }

  const type = String(responseFormat.type || "").trim().toLowerCase();
  if (!type || type === "text") {
    return {
      type: "text",
      jsonSchema: null,
      outputFormat: null,
    };
  }

  if (type === "json_object") {
    return {
      type,
      jsonSchema: {
        type: "object",
      },
      outputFormat: {
        type: "json_object",
      },
    };
  }

  if (type === "json_schema") {
    const jsonSchema =
      responseFormat?.json_schema?.schema && typeof responseFormat.json_schema.schema === "object"
        ? responseFormat.json_schema.schema
        : responseFormat?.schema && typeof responseFormat.schema === "object"
          ? responseFormat.schema
          : null;
    if (!jsonSchema) {
      throw new Error("response_format.json_schema.schema is required");
    }
    return {
      type,
      jsonSchema,
      outputFormat: {
        type: "json_schema",
        schema: jsonSchema,
      },
    };
  }

  throw new Error(`unsupported response_format.type: ${type}`);
}

function tryParseJson(text) {
  try {
    return {
      ok: true,
      value: JSON.parse(text),
    };
  } catch {
    return {
      ok: false,
      value: null,
    };
  }
}

function unwrapJsonCodeFence(text) {
  const normalized = String(text || "").trim();
  const match = normalized.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return match ? match[1].trim() : normalized;
}

function findBalancedJsonSubstring(text) {
  const source = String(text || "");
  for (let start = 0; start < source.length; start += 1) {
    const opener = source[start];
    if (opener !== "{" && opener !== "[") {
      continue;
    }

    const stack = [opener === "{" ? "}" : "]"];
    let inString = false;
    let escaped = false;

    for (let index = start + 1; index < source.length; index += 1) {
      const char = source[index];
      if (inString) {
        if (escaped) {
          escaped = false;
          continue;
        }
        if (char === "\\") {
          escaped = true;
          continue;
        }
        if (char === "\"") {
          inString = false;
        }
        continue;
      }

      if (char === "\"") {
        inString = true;
        continue;
      }
      if (char === "{") {
        stack.push("}");
        continue;
      }
      if (char === "[") {
        stack.push("]");
        continue;
      }
      if ((char === "}" || char === "]") && stack.at(-1) === char) {
        stack.pop();
        if (stack.length === 0) {
          const candidate = source.slice(start, index + 1).trim();
          const parsed = tryParseJson(candidate);
          if (parsed.ok) {
            return parsed.value;
          }
          break;
        }
      }
    }
  }
  return null;
}

function extractStructuredOutputValue(result) {
  if (!result || typeof result !== "object") {
    return undefined;
  }
  if (
    result.metadata &&
    typeof result.metadata === "object" &&
    Object.prototype.hasOwnProperty.call(result.metadata, "structuredOutput")
  ) {
    return result.metadata.structuredOutput;
  }
  return undefined;
}

function parseStructuredOutputText(text) {
  const normalized = String(text || "").trim();
  if (!normalized) {
    throw new Error("structured output is empty");
  }

  const direct = tryParseJson(normalized);
  if (direct.ok) {
    return direct.value;
  }

  const unfenced = unwrapJsonCodeFence(normalized);
  if (unfenced !== normalized) {
    const fenced = tryParseJson(unfenced);
    if (fenced.ok) {
      return fenced.value;
    }
  }

  const extracted = findBalancedJsonSubstring(unfenced);
  if (extracted !== null) {
    return extracted;
  }

  throw new Error("structured output is not valid JSON");
}

function normalizeUsage(usage) {
  const promptTokens =
    Number(usage?.prompt_tokens ?? usage?.input_tokens ?? usage?.inputTokens ?? usage?.input ?? 0) || 0;
  const completionTokens =
    Number(usage?.completion_tokens ?? usage?.output_tokens ?? usage?.outputTokens ?? usage?.output ?? 0) || 0;
  const totalTokens =
    Number(usage?.total_tokens ?? usage?.totalTokens ?? promptTokens + completionTokens) || 0;

  return {
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens: totalTokens,
  };
}

export function assertStructuredOutputText(text, responseFormat) {
  if (!responseFormat || responseFormat.type === "text") {
    return;
  }
  JSON.parse(String(text || ""));
}

export function normalizeStructuredOutputResult(result, responseFormat) {
  if (!responseFormat || responseFormat.type === "text") {
    return result;
  }

  const metadataStructuredOutput = extractStructuredOutputValue(result);
  if (metadataStructuredOutput !== undefined) {
    return {
      ...(result && typeof result === "object" ? result : {}),
      text: JSON.stringify(metadataStructuredOutput),
    };
  }

  return {
    ...(result && typeof result === "object" ? result : {}),
    text: JSON.stringify(parseStructuredOutputText(result?.text)),
  };
}

export function toOpenAiChatCompletion(result, { model }) {
  const text = typeof result?.text === "string" ? result.text : "";
  return {
    id: `chatcmpl-${randomUUID()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: text,
        },
        finish_reason: "stop",
      },
    ],
    usage: normalizeUsage(result?.usage),
  };
}
