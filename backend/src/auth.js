import crypto from "crypto";

const agentTokens = new Set();

export function createAgentToken() {
  const token = crypto.randomBytes(24).toString("hex");
  agentTokens.add(token);
  return token;
}

export function requireAgent(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (!agentTokens.has(token)) {
    return res.status(401).json({ error: "Agent access required." });
  }
  req.agentToken = token;
  next();
}

export function checkAgentToken(token) {
  return agentTokens.has(token);
}
