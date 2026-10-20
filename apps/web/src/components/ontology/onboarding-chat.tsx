"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { trpc } from "@/lib/trpc";
import { AgentMarkdown } from "@/components/agent-markdown";

type Message = {
  id: string;
  role: "user" | "assistant";
  content: string;
};

export function OnboardingChat() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [agentStatus, setAgentStatus] = useState<string | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const utils = trpc.useUtils();

  const { mutateAsync: ask } =
    trpc.views.knowledge.ontologyAgent.ask.useMutation({ onError: () => {} });

  trpc.views.knowledge.ontologyAgent.onUpdate.useSubscription(
    { sessionId: sessionId ?? "" },
    {
      enabled: !!sessionId,
      onData: (update) => {
        if (!update || typeof update !== "object") return;

        if (update.type === "complete") {
          const { text } = update.data ?? {};
          setMessages((prev) => [
            ...prev,
            {
              id: `a-${Date.now()}`,
              role: "assistant" as const,
              content: text ?? "No response generated",
            },
          ]);
          setIsLoading(false);
          setSessionId(null);
          setAgentStatus(null);
          utils.views.knowledge.ontology.getOntologySummary.invalidate();
        } else if (update.type === "error") {
          setMessages((prev) => [
            ...prev,
            {
              id: `a-${Date.now()}`,
              role: "assistant" as const,
              content: "Something went wrong. Please try again.",
            },
          ]);
          setIsLoading(false);
          setSessionId(null);
          setAgentStatus(null);
        } else if (typeof update.message === "string") {
          setAgentStatus(update.message);
        }
      },
      onError: () => {},
    },
  );

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, agentStatus]);

  // No agent call until the user actually says something — visiting the
  // page must not create a conversation (it used to auto-send "Hi",
  // minting a new chat and an agent turn on every mount). The welcome
  // is static copy; the FIRST user message carries the onboarding flag
  // so the agent still responds in setup mode.
  const handleSend = useCallback(async () => {
    const text = input.trim();
    if (!text || isLoading) return;

    const newSessionId = `oa-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    setSessionId(newSessionId);
    setInput("");
    setIsLoading(true);
    setAgentStatus(null);

    const userMsg: Message = {
      id: `u-${Date.now()}`,
      role: "user",
      content: text,
    };
    setMessages((prev) => [...prev, userMsg]);

    try {
      const result = await ask({
        message: text,
        sessionId: newSessionId,
        conversationId: conversationId ?? undefined,
        onboarding: conversationId === null,
      });

      if (!conversationId && result.conversationId) {
        setConversationId(result.conversationId);
      }
    } catch {
      setMessages((prev) => [
        ...prev,
        {
          id: `a-${Date.now()}`,
          role: "assistant",
          content: "Something went wrong. Please try again.",
        },
      ]);
      setIsLoading(false);
      setAgentStatus(null);
    }
  }, [input, isLoading, ask, conversationId]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  return (
    <div className="flex h-full flex-col items-center">
      <div className="flex w-full max-w-2xl flex-1 flex-col">
        {/* Messages area */}
        <div className="flex-1 overflow-y-auto px-4 py-8">
          {/* Welcome header — shown while waiting for first response */}
          {messages.length === 0 && (
            <div className="flex flex-col items-center gap-3 pb-8 pt-12 text-center">
              <div className="flex h-12 w-12 items-center justify-center rounded-full bg-primary/10">
                <svg
                  className="h-6 w-6 text-primary"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
                </svg>
              </div>
              <div>
                <h2 className="text-lg font-semibold text-gray-900">
                  Welcome to TARS
                </h2>
                <p className="mt-1 text-[13px] text-gray-500">
                  Your data model is empty. Tell the assistant about your work — the
                  companies, deals, people, whatever you track — and it will
                  set the model up with you.
                </p>
              </div>
            </div>
          )}

          {messages.map((msg) => (
            <div
              key={msg.id}
              className={`mb-4 ${msg.role === "user" ? "ml-12" : "mr-4"}`}
            >
              <div
                className={`overflow-hidden rounded-xl px-4 py-3 text-[14px] leading-relaxed ${
                  msg.role === "user"
                    ? "bg-primary/10 text-gray-800"
                    : "bg-gray-50 text-gray-700"
                }`}
              >
                {msg.role === "assistant" ? (
                  <div className="prose prose-sm max-w-none prose-headings:text-gray-900">
                    <AgentMarkdown content={msg.content} />
                  </div>
                ) : (
                  <span className="whitespace-pre-wrap">{msg.content}</span>
                )}
              </div>
            </div>
          ))}

          {isLoading && (
            <div className="mb-4 mr-4">
              <div className="rounded-xl bg-gray-50 px-4 py-3">
                <div className="flex items-center gap-2">
                  <div className="h-1.5 w-1.5 animate-pulse rounded-full bg-gray-400" />
                  <div
                    className="h-1.5 w-1.5 animate-pulse rounded-full bg-gray-400"
                    style={{ animationDelay: "0.2s" }}
                  />
                  <div
                    className="h-1.5 w-1.5 animate-pulse rounded-full bg-gray-400"
                    style={{ animationDelay: "0.4s" }}
                  />
                </div>
                {agentStatus && (
                  <p className="mt-2 text-[12px] italic text-gray-400">
                    {agentStatus}
                  </p>
                )}
              </div>
            </div>
          )}

          <div ref={messagesEndRef} />
        </div>

        {/* Input */}
        <div className="shrink-0 border-t border-gray-100 px-4 py-4">
          <div className="flex items-end gap-3">
            <textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Tell the assistant about your work..."
              rows={1}
              className="flex-1 resize-none rounded-xl border border-gray-200 px-4 py-2.5 text-[14px] placeholder:text-gray-400 focus:border-gray-400 focus:outline-none"
            />
            <button
              onClick={handleSend}
              disabled={!input.trim() || isLoading}
              className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-primary text-white transition-colors hover:bg-primary-600 disabled:cursor-not-allowed disabled:opacity-40"
            >
              <svg
                className="h-4 w-4"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <line x1="22" y1="2" x2="11" y2="13" />
                <polygon points="22 2 15 22 11 13 2 9 22 2" />
              </svg>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
