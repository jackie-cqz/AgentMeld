"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Message } from "@/shared/types";

interface Props {
  messages: Message[];
  scrollerRef: React.RefObject<HTMLDivElement | null>;
  rightOffset?: number;
}

export function ConversationTimeline({ messages, scrollerRef, rightOffset = 0 }: Props) {
  const [hoveredIdx, setHoveredIdx] = useState<number | null>(null);
  const [activeIdx, setActiveIdx] = useState<number>(0);
  const containerRef = useRef<HTMLDivElement>(null);

  // Only show user messages (their questions/prompts)
  const userMessages = useMemo(
    () => messages.filter((message) => message.role === "user"),
    [messages]
  );

  // Update active marker based on scroll position
  const updateActive = useCallback(() => {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    const scrollHeight = scroller.scrollHeight;
    const clientHeight = scroller.clientHeight;
    if (scrollHeight <= clientHeight) return;

    // Find which user message is closest to the viewport top
    let best = 0;
    let bestDist = Infinity;
    for (let i = 0; i < userMessages.length; i++) {
      const el = document.getElementById(`message-${userMessages[i].id}`);
      if (el) {
        const rect = el.getBoundingClientRect();
        const dist = Math.abs(rect.top - 80); // ~header height
        if (dist < bestDist) { bestDist = dist; best = i; }
      }
    }
    setActiveIdx((current) => current === best ? current : best);
  }, [userMessages, scrollerRef]);

  useEffect(() => {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    scroller.addEventListener("scroll", updateActive, { passive: true });
    updateActive();
    return () => scroller.removeEventListener("scroll", updateActive);
  }, [updateActive, scrollerRef]);

  const scrollTo = (msgId: string) => {
    const el = document.getElementById(`message-${msgId}`);
    if (el) {
      el.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  };

  const getPreview = (msg: Message) => {
    const text = msg.parts
      .filter((p) => p.type === "text")
      .map((p) => p.content)
      .join(" ")
      .trim();
    return text.length > 10 ? text.slice(0, 10) + "…" : text;
  };

  if (userMessages.length <= 1) return null;

  return (
    <div
      ref={containerRef}
      className="absolute top-0 bottom-0 z-10 flex w-5 flex-col items-center justify-center py-4"
      style={{ right: rightOffset + 16 }}
    >
      <div className="relative flex flex-col items-center gap-1">
        {userMessages.map((msg, i) => (
          <div
            key={msg.id}
            className="relative"
            onMouseEnter={() => setHoveredIdx(i)}
            onMouseLeave={() => setHoveredIdx(null)}
          >
            <button
              onClick={() => scrollTo(msg.id)}
              className={`block rounded-full transition-all ${
                i === activeIdx
                  ? "h-2.5 w-2.5 bg-[#4264ff] shadow-sm"
                  : "h-1.5 w-1.5 bg-slate-300 hover:bg-slate-400"
              }`}
              title={`跳转到第 ${i + 1} 条消息`}
            />
            {/* Tooltip on hover */}
            {hoveredIdx === i ? (
              <div className="absolute right-full mr-3 top-1/2 -translate-y-1/2 z-20 max-w-[200px] rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-xs text-slate-700 shadow-lg whitespace-nowrap">
                <span className="font-medium text-slate-400">#{i + 1}</span>
                <span className="ml-1">{getPreview(msg)}</span>
              </div>
            ) : null}
          </div>
        ))}
      </div>
    </div>
  );
}
