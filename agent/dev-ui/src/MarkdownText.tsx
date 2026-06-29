import "@assistant-ui/react-markdown/styles/dot.css";
import { MarkdownTextPrimitive } from "@assistant-ui/react-markdown";
import type { FC } from "react";

export const MarkdownText: FC = () => (
  <MarkdownTextPrimitive className="debug-md" />
);
