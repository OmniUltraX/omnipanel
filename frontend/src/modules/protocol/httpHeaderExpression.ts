export class HttpHeaderExpressionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HttpHeaderExpressionError";
  }
}

type ExprNode =
  | { type: "string"; value: string }
  | { type: "number"; value: number }
  | { type: "ident"; name: string }
  | { type: "call"; name: string; args: ExprNode[] }
  | { type: "binary"; op: "+"; left: ExprNode; right: ExprNode };

type Token =
  | { type: "string"; value: string }
  | { type: "number"; value: number }
  | { type: "ident"; value: string }
  | { type: "lparen" }
  | { type: "rparen" }
  | { type: "comma" }
  | { type: "plus" }
  | { type: "eof" };

function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;

  while (i < input.length) {
    const ch = input[i];
    if (/\s/.test(ch)) {
      i += 1;
      continue;
    }

    if (ch === "'" || ch === '"') {
      const quote = ch;
      i += 1;
      let value = "";
      let closed = false;
      while (i < input.length) {
        const current = input[i];
        if (current === "\\") {
          i += 1;
          if (i >= input.length) {
            throw new HttpHeaderExpressionError("字符串字面量未闭合");
          }
          const escaped = input[i];
          if (escaped === "n") value += "\n";
          else if (escaped === "t") value += "\t";
          else if (escaped === "r") value += "\r";
          else value += escaped;
          i += 1;
          continue;
        }
        if (current === quote) {
          i += 1;
          closed = true;
          break;
        }
        value += current;
        i += 1;
      }
      if (!closed) {
        throw new HttpHeaderExpressionError("字符串字面量未闭合");
      }
      tokens.push({ type: "string", value });
      continue;
    }

    if (/[0-9]/.test(ch)) {
      let raw = "";
      while (i < input.length && /[0-9]/.test(input[i])) {
        raw += input[i];
        i += 1;
      }
      tokens.push({ type: "number", value: Number(raw) });
      continue;
    }

    if (/[A-Za-z_]/.test(ch)) {
      let raw = "";
      while (i < input.length && /[A-Za-z0-9_]/.test(input[i])) {
        raw += input[i];
        i += 1;
      }
      tokens.push({ type: "ident", value: raw });
      continue;
    }

    if (ch === "(") {
      tokens.push({ type: "lparen" });
      i += 1;
      continue;
    }
    if (ch === ")") {
      tokens.push({ type: "rparen" });
      i += 1;
      continue;
    }
    if (ch === ",") {
      tokens.push({ type: "comma" });
      i += 1;
      continue;
    }
    if (ch === "+") {
      tokens.push({ type: "plus" });
      i += 1;
      continue;
    }

    throw new HttpHeaderExpressionError(`无法识别的字符: ${ch}`);
  }

  tokens.push({ type: "eof" });
  return tokens;
}

class Parser {
  private index = 0;
  private readonly tokens: Token[];

  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  parse(): ExprNode {
    const expr = this.parseExpression();
    if (this.peek().type !== "eof") {
      throw new HttpHeaderExpressionError("表达式存在多余内容");
    }
    return expr;
  }

  private parseExpression(): ExprNode {
    let node = this.parsePrimary();
    while (this.peek().type === "plus") {
      this.index += 1;
      const right = this.parsePrimary();
      node = { type: "binary", op: "+", left: node, right };
    }
    return node;
  }

  private parsePrimary(): ExprNode {
    const token = this.peek();
    if (token.type === "string") {
      this.index += 1;
      return { type: "string", value: token.value };
    }
    if (token.type === "number") {
      this.index += 1;
      return { type: "number", value: token.value };
    }
    if (token.type === "ident") {
      this.index += 1;
      if (this.peek().type === "lparen") {
        return this.parseCall(token.value);
      }
      return { type: "ident", name: token.value };
    }
    if (token.type === "lparen") {
      this.index += 1;
      const expr = this.parseExpression();
      this.expect("rparen", "缺少右括号 )");
      return expr;
    }
    throw new HttpHeaderExpressionError("表达式不完整");
  }

  private parseCall(name: string): ExprNode {
    this.expect("lparen", "缺少左括号 (");
    const args: ExprNode[] = [];
    if (this.peek().type !== "rparen") {
      do {
        args.push(this.parseExpression());
        if (this.peek().type === "comma") {
          this.index += 1;
          continue;
        }
        break;
      } while (true);
    }
    this.expect("rparen", "缺少右括号 )");
    return { type: "call", name, args };
  }

  private peek(): Token {
    return this.tokens[this.index] ?? { type: "eof" };
  }

  private expect(type: Token["type"], message: string): void {
    if (this.peek().type !== type) {
      throw new HttpHeaderExpressionError(message);
    }
    this.index += 1;
  }
}

async function hmacSha256Hex(key: string, message: string): Promise<string> {
  const encoder = new TextEncoder();
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    encoder.encode(key),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", cryptoKey, encoder.encode(message));
  return Array.from(new Uint8Array(signature))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function evalNode(node: ExprNode, nowMs: number): Promise<string | number> {
  switch (node.type) {
    case "string":
      return node.value;
    case "number":
      return node.value;
    case "ident":
      if (node.name === "unix_timestamp") {
        return Math.floor(nowMs / 1000);
      }
      throw new HttpHeaderExpressionError(`未知变量: ${node.name}`);
    case "binary": {
      const left = await evalNode(node.left, nowMs);
      const right = await evalNode(node.right, nowMs);
      return `${left}${right}`;
    }
    case "call": {
      if (node.name === "hmac_sha256") {
        if (node.args.length !== 2) {
          throw new HttpHeaderExpressionError("hmac_sha256 需要 2 个参数");
        }
        const key = String(await evalNode(node.args[0], nowMs));
        const message = String(await evalNode(node.args[1], nowMs));
        return await hmacSha256Hex(key, message);
      }
      throw new HttpHeaderExpressionError(`未知函数: ${node.name}`);
    }
    default:
      throw new HttpHeaderExpressionError("无法解析表达式");
  }
}

/** 解析并求值请求头函数表达式。 */
export async function evaluateHeaderExpression(
  expression: string,
  options?: { nowMs?: number },
): Promise<string> {
  const trimmed = expression.trim();
  if (!trimmed) {
    throw new HttpHeaderExpressionError("表达式不能为空");
  }
  const parser = new Parser(tokenize(trimmed));
  const ast = parser.parse();
  const result = await evalNode(ast, options?.nowMs ?? Date.now());
  return String(result);
}
