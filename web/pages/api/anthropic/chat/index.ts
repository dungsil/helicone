import { NextApiRequest, NextApiResponse } from "next";
import Anthropic from "@anthropic-ai/sdk";

import { DEMO_EMAIL } from "../../../../lib/constants";
import { Result } from "../../../../lib/result";
import { SupabaseServerWrapper } from "../../../../lib/wrappers/supabase";

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse<Result<Anthropic.Messages.Message, string>>
) {
  const client = new SupabaseServerWrapper({ req, res }).getClient();
  const user = await client.auth.getUser();
  const { messages, requestId, temperature, model, maxTokens } = req.body as {
    messages: Anthropic.Messages.Message[];
    requestId: string;
    temperature: number;
    model: string;
    maxTokens: number;
  };

  if (!temperature || !model) {
    res.status(400).json({
      error: "Bad request - missing required body parameters",
      data: null,
    });
    return;
  }

  const anthropic = new Anthropic({
    baseURL: "https://anthropic.hconeai.com/",
    apiKey: process.env.ANTHROPIC_API_KEY,
    defaultHeaders: {
      "Helicone-Auth": `Bearer ${process.env.TEST_HELICONE_API_KEY}`,
      user: user.data.user?.id || "",
      "Helicone-Property-RequestId": requestId,
      "Helicone-Property-Tag": "experiment",
    },
  });

  if (!user.data || !user.data.user) {
    res.status(401).json({ error: "Unauthorized", data: null });
    return;
  }
  if (user.data.user.email === DEMO_EMAIL) {
    res.status(401).json({ error: "Unauthorized", data: null });
    return;
  }

  try {
    const completion = await anthropic.messages.create({
      model: "claude-3-opus-20240229",
      max_tokens: maxTokens,
      temperature: temperature,
      metadata: {
        user_id: user.data.user.id,
      },
      messages: messages,
    });
    res.status(200).json({ error: null, data: completion });
    return;
  } catch (err) {
    res.status(500).json({ error: `${err}`, data: null });
    return;
  }
}
