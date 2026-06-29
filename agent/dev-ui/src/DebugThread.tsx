import {
  ComposerPrimitive,
  MessagePrimitive,
  ThreadPrimitive,
} from "@assistant-ui/react";
import { ArrowUpIcon, SquareIcon } from "lucide-react";
import type { FC } from "react";
import { DebugReasoning } from "./DebugReasoning";
import { MarkdownText } from "./MarkdownText";

const UserMessage: FC = () => (
  <MessagePrimitive.Root className="debug-msg debug-msg--user">
    <div className="debug-msg__bubble">
      <MessagePrimitive.Content />
    </div>
  </MessagePrimitive.Root>
);

const AssistantMessage: FC = () => (
  <MessagePrimitive.Root className="debug-msg debug-msg--assistant">
    <div className="debug-msg__bubble">
      <MessagePrimitive.Content
        components={{
          Text: MarkdownText,
          Reasoning: DebugReasoning,
          tools: {
            Fallback: ({ toolName, argsText, result, isError }) => (
              <details className="debug-tool" open={Boolean(isError)}>
                <summary className="debug-tool__summary">
                  <span className="debug-tool__name">{toolName}</span>
                  {isError ? <span className="debug-tool__badge">失败</span> : null}
                </summary>
                {argsText ? (
                  <pre className="debug-tool__block">
                    <strong>输入</strong>
                    {"\n"}
                    {argsText}
                  </pre>
                ) : null}
                {result !== undefined && result !== null ? (
                  <pre className="debug-tool__block">
                    <strong>输出</strong>
                    {"\n"}
                    {typeof result === "string" ? result : JSON.stringify(result, null, 2)}
                  </pre>
                ) : null}
              </details>
            ),
          },
        }}
      />
    </div>
  </MessagePrimitive.Root>
);

export function DebugThread() {
  return (
    <ThreadPrimitive.Root className="debug-thread">
      <ThreadPrimitive.Viewport className="debug-thread__viewport">
        <div className="debug-thread__empty">
          <ThreadPrimitive.Empty>
            <h2>OmniAgent 调试</h2>
            <p>直接向 DeepAgents 发消息，无需 ACP / OmniPanel 桌面环境。</p>
            <ul>
              <li>
                在 <code>agent</code> 目录运行 <code>npm run start:web</code>
              </li>
              <li>
                浏览器打开 <code>http://127.0.0.1:9478</code>
              </li>
              <li>
                配置 <code>debug-config.json</code> 或 <code>OMNIAGENT_CONFIG</code>
              </li>
            </ul>
          </ThreadPrimitive.Empty>
        </div>
        <ThreadPrimitive.Messages
          components={{
            UserMessage,
            AssistantMessage,
          }}
        />
      </ThreadPrimitive.Viewport>

      <div className="debug-composer-wrap">
        <ComposerPrimitive.Root className="debug-composer">
          <ComposerPrimitive.Input
            className="debug-composer__input"
            placeholder="输入消息调试 Agent…"
            rows={1}
            autoFocus
          />
          <ThreadPrimitive.If running={false}>
            <ComposerPrimitive.Send className="debug-composer__send" aria-label="发送">
              <ArrowUpIcon size={16} />
            </ComposerPrimitive.Send>
          </ThreadPrimitive.If>
          <ThreadPrimitive.If running>
            <ComposerPrimitive.Cancel className="debug-composer__cancel" aria-label="停止">
              <SquareIcon size={14} />
            </ComposerPrimitive.Cancel>
          </ThreadPrimitive.If>
        </ComposerPrimitive.Root>
      </div>
    </ThreadPrimitive.Root>
  );
}
