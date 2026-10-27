import { createHmac } from "node:crypto";

export const webhookSecret = `whsec_${Buffer.alloc(32, 7).toString("base64")}`;
export const providerMessageId = "56761188-7520-42d8-8898-ff6fc54ce618";

export const webhookPayload = (
  type = "email.delivered",
  createdAt = new Date(),
) =>
  JSON.stringify({
    type,
    created_at: createdAt.toISOString(),
    data: {
      email_id: providerMessageId,
      to: ["webhook-fixture@example.com"],
      subject: "Fixture subject",
      html: "Private fixture body",
    },
  });

export const webhookHeaders = (
  payload: string,
  id = "msg_fixture",
  timestamp = new Date(),
) => {
  const seconds = Math.floor(timestamp.getTime() / 1_000).toString();
  const signature = createHmac("sha256", Buffer.alloc(32, 7))
    .update(`${id}.${seconds}.${payload}`)
    .digest("base64");
  return {
    "content-type": "application/json",
    "svix-id": id,
    "svix-timestamp": seconds,
    "svix-signature": `v1,${signature}`,
  };
};
