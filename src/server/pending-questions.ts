import { nanoid } from "nanoid";
import { eventBus } from "@/server/event-bus";

export interface PendingQuestion {
  id: string;
  conversationId: string;
  agentId: string;
  runId: string;
  questions: Array<{
    question: string;
    header: string;
    options: Array<{ label: string; description?: string }>;
    multiSelect?: boolean;
  }>;
  createdAt: number;
}

type AnswerResolver = (answers: Record<string, string>) => void;

interface QuestionEntry {
  question: PendingQuestion;
  resolver: AnswerResolver;
}

declare global {
  var __agentConferencePendingQuestions: Map<string, QuestionEntry> | undefined;
}

function getStore(): Map<string, QuestionEntry> {
  if (!globalThis.__agentConferencePendingQuestions) {
    globalThis.__agentConferencePendingQuestions = new Map();
  }
  return globalThis.__agentConferencePendingQuestions;
}

export function registerPendingQuestion(
  conversationId: string,
  agentId: string,
  runId: string,
  questions: PendingQuestion["questions"]
): Promise<Record<string, string>> {
  const store = getStore();
  const id = `pq_${nanoid(12)}`;

  return new Promise((resolve) => {
    const entry: QuestionEntry = {
      question: {
        id,
        conversationId,
        agentId,
        runId,
        questions,
        createdAt: Date.now()
      },
      resolver: (answers) => {
        store.delete(id);
        resolve(answers);
      }
    };
    store.set(id, entry);

    eventBus.publish({
      type: "ask_user.pending" as never,
      conversationId,
      timestamp: Date.now(),
      pendingQuestion: entry.question
    } as never);
  });
}

export function getPendingQuestion(id: string): QuestionEntry | undefined {
  return getStore().get(id);
}

export function getPendingQuestionsForConversation(conversationId: string): PendingQuestion[] {
  return Array.from(getStore().values())
    .map((e) => e.question)
    .filter((q) => q.conversationId === conversationId);
}

export function answerQuestion(id: string, answers: Record<string, string>): boolean {
  const entry = getStore().get(id);
  if (!entry) return false;
  entry.resolver(answers);
  return true;
}

export function cancelPendingQuestionsForRun(runId: string): void {
  const store = getStore();
  for (const [id, entry] of store) {
    if (entry.question.runId === runId) {
      entry.resolver({});
      store.delete(id);
    }
  }
}

export function clearPendingQuestionsForTests(): void {
  const store = getStore();
  for (const [, entry] of store) {
    entry.resolver({});
  }
  store.clear();
}
