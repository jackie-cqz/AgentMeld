"use client";

import { Check, Copy } from "lucide-react";
import React, { useState } from "react";

export function MarkdownRenderer({ content }: { content: string }) {
  const lines = content.split("\n");
  const elements: React.ReactNode[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // Code block
    if (line.startsWith("```")) {
      const lang = line.slice(3).trim();
      const codeLines: string[] = [];
      i++;
      while (i < lines.length && !lines[i].startsWith("```")) {
        codeLines.push(lines[i]);
        i++;
      }
      i++; // skip closing ```
      elements.push(<CodeBlock key={i} code={codeLines.join("\n")} language={lang || undefined} />);
      continue;
    }

    // Heading
    if (/^#{1,6}\s/.test(line)) {
      const level = line.match(/^(#{1,6})/)![1].length;
      const text = line.replace(/^#{1,6}\s+/, "");
      const cls = level <= 2 ? "text-base font-semibold" : level === 3 ? "text-sm font-medium" : "text-xs font-medium";
      const Tag = level === 1 ? "h1" : level === 2 ? "h2" : "h3" as const;
      elements.push(
        React.createElement(Tag, { key: i, className: `mt-3 mb-1 first:mt-0 ${cls} text-stone-900` }, text)
      );
      i++; continue;
    }

    // Unordered list
    if (/^[-*]\s/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^[-*]\s/.test(lines[i])) {
        items.push(lines[i].replace(/^[-*]\s+/, ""));
        i++;
      }
      elements.push(
        <ul key={i} className="my-1 list-disc space-y-0.5 pl-5 text-stone-700">
          {items.map((item, idx) => <li key={idx} className="text-sm leading-6">{renderInline(item)}</li>)}
        </ul>
      );
      continue;
    }

    // Ordered list
    if (/^\d+\.\s/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\d+\.\s/.test(lines[i])) {
        items.push(lines[i].replace(/^\d+\.\s+/, ""));
        i++;
      }
      elements.push(
        <ol key={i} className="my-1 list-decimal space-y-0.5 pl-5 text-stone-700">
          {items.map((item, idx) => <li key={idx} className="text-sm leading-6">{renderInline(item)}</li>)}
        </ol>
      );
      continue;
    }

    // Horizontal rule
    if (/^---\s*$/.test(line)) {
      elements.push(<hr key={i} className="my-3 border-stone-200" />);
      i++; continue;
    }

    // Blockquote
    if (line.startsWith("> ")) {
      const quoteLines: string[] = [];
      while (i < lines.length && lines[i].startsWith("> ")) {
        quoteLines.push(lines[i].slice(2));
        i++;
      }
      elements.push(
        <blockquote key={i} className="my-2 border-l-2 border-stone-300 pl-3 text-sm text-stone-600 italic">
          {quoteLines.map((ql, idx) => <p key={idx} className="my-0.5">{renderInline(ql)}</p>)}
        </blockquote>
      );
      continue;
    }

    // Table
    if (line.startsWith("|") && line.endsWith("|")) {
      const tableRows: string[][] = [];
      while (i < lines.length && lines[i].startsWith("|") && lines[i].endsWith("|")) {
        tableRows.push(lines[i].split("|").slice(1, -1).map(c => c.trim()));
        i++;
      }
      if (tableRows.length >= 2) {
        const [header, sep, ...body] = tableRows;
        elements.push(
          <div key={i} className="my-2 overflow-x-auto">
            <table className="min-w-full text-sm border-collapse">
              <thead>
                <tr className="border-b border-stone-300">
                  {header.map((h, idx) => <th key={idx} className="px-2 py-1 text-left font-medium text-stone-700">{renderInline(h)}</th>)}
                </tr>
              </thead>
              <tbody>
                {body.map((row, ri) => (
                  <tr key={ri} className="border-b border-stone-100">
                    {row.map((cell, ci) => <td key={ci} className="px-2 py-1 text-stone-600">{renderInline(cell)}</td>)}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        );
      }
      continue;
    }

    // Empty line
    if (line.trim() === "") { elements.push(<div key={i} className="h-2" />); i++; continue; }

    // Regular paragraph
    elements.push(<p key={i} className="my-1 text-sm leading-6 text-stone-800">{renderInline(line)}</p>);
    i++;
  }

  return <div>{elements}</div>;
}

function renderInline(text: string): React.ReactNode {
  // Bold + inline code
  const parts = text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g);
  return parts.map((part, i) => {
    if (part.startsWith("**") && part.endsWith("**")) {
      return <strong key={i} className="font-semibold text-stone-900">{part.slice(2, -2)}</strong>;
    }
    if (part.startsWith("`") && part.endsWith("`")) {
      return <code key={i} className="rounded bg-stone-200 px-1 py-0.5 text-xs font-mono text-stone-800">{part.slice(1, -1)}</code>;
    }
    return part;
  });
}

export function CodeBlock({ code, language }: { code: string; language?: string }) {
  const [copied, setCopied] = useState(false);
  const handleCopy = () => { navigator.clipboard.writeText(code); setCopied(true); setTimeout(() => setCopied(false), 1500); };

  return (
    <div className="my-2 rounded-md border border-stone-300 overflow-hidden">
      <div className="flex items-center justify-between bg-stone-100 px-3 py-1.5 border-b border-stone-200">
        <span className="text-xs text-stone-500 font-mono">{language || "code"}</span>
        <button onClick={handleCopy} className="flex items-center gap-1 text-xs text-stone-500 hover:text-stone-900">
          {copied ? <Check className="h-3 w-3 text-emerald-500" /> : <Copy className="h-3 w-3" />}
          {copied ? "已复制" : "复制"}
        </button>
      </div>
      <pre className="overflow-x-auto bg-stone-950 p-3 text-sm text-stone-50 font-mono whitespace-pre">
        <code>{code}</code>
      </pre>
    </div>
  );
}
