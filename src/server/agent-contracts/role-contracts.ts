// ---------------------------------------------------------------------------
// P5: Standard role output contracts — PM / UI / Frontend / Reviewer
// ---------------------------------------------------------------------------

import type { CriterionValidator } from "@/shared/evidence-types";

export type AgentRole = "pm" | "ui" | "frontend" | "reviewer";

export interface RoleOutputContract {
  role: AgentRole;
  /** Canonical output key — system-enforced, not LLM-generated */
  outputKey: string;
  type: "document" | "web_app" | "image" | "ppt";
  required: boolean;
  /** Output keys that this role should read from upstream */
  requiredInputs: string[];
  /** Tools this role typically needs */
  expectedTools: string[];
  /** Standard content requirements — injected into task prompt */
  contentRequirements: string[];
  /** Standard acceptance criteria with auto-validators */
  acceptanceCriteria: Array<{
    description: string;
    required: boolean;
    validator: CriterionValidator;
  }>;
}

// ── Standard contracts ──────────────────────────────────────────────────────

export const PM_CONTRACT: RoleOutputContract = {
  role: "pm",
  outputKey: "prd",
  type: "document",
  required: true,
  requiredInputs: [],
  expectedTools: ["write_artifact", "read_artifact", "ask_user"],
  contentRequirements: [
    "产品目标与概述",
    "目标用户与使用场景",
    "核心功能列表（P0 / P1 / P2 优先级分级）",
    "非目标与范围边界",
    "可量化、可测试的验收标准",
  ],
  acceptanceCriteria: [
    {
      description: "PRD 产物已创建",
      required: true,
      validator: { type: "artifact_exists", outputKey: "prd", artifactType: "document" },
    },
  ],
};

export const UI_CONTRACT: RoleOutputContract = {
  role: "ui",
  outputKey: "style-guide",
  type: "document",
  required: true,
  requiredInputs: ["prd"],
  expectedTools: ["write_artifact", "read_artifact"],
  contentRequirements: [
    "视觉方向与设计目标",
    "配色方案（主色 / 辅色 / 背景 / 文字 / 状态色，含 CSS 变量）",
    "字体选择与字号层级",
    "布局规则与网格系统（含响应式断点）",
    "核心组件规范（按钮 / 输入框 / 卡片 / 导航 / 进度指示 / 标签等）",
    "间距、圆角、阴影系统化参数",
    "交互状态（hover / active / disabled / loading / 过渡动画）",
  ],
  acceptanceCriteria: [
    {
      description: "风格指南产物已创建",
      required: true,
      validator: { type: "artifact_exists", outputKey: "style-guide", artifactType: "document" },
    },
  ],
};

export const FRONTEND_CONTRACT: RoleOutputContract = {
  role: "frontend",
  outputKey: "web_app",
  type: "web_app",
  required: true,
  requiredInputs: ["prd", "style-guide"],
  expectedTools: ["read_artifact", "write_artifact", "fs_read", "fs_mkdir", "fs_write", "fs_patch", "bash", "deploy_workspace"],
  contentRequirements: [
    "实现 PRD 中定义的所有 P0 功能",
    "严格遵循风格指南中的设计参数",
    "若采用 npm/pnpm 项目结构，必须运行并通过构建；若采用纯 HTML/CSS/JS 静态实现，则以 index.html 可部署为准",
    "产物可通过 deploy_workspace 部署并预览",
  ],
  acceptanceCriteria: [
    {
      description: "web_app 产物已创建",
      required: true,
      validator: { type: "artifact_exists", outputKey: "web_app", artifactType: "web_app" },
    },
    {
      description: "部署成功",
      required: false,
      validator: { type: "deployment_created", outputKey: "web_app" },
    },
  ],
};

export const REVIEWER_CONTRACT: RoleOutputContract = {
  role: "reviewer",
  outputKey: "review_report",
  type: "document",
  required: true,
  requiredInputs: ["prd", "style-guide", "web_app"],
  expectedTools: ["read_artifact", "write_artifact", "fs_read", "fs_list", "bash"],
  contentRequirements: [
    "对照 PRD 逐项检查功能是否完整实现",
    "对照风格指南检查 UI 一致性",
    "检查构建状态与部署是否正常",
    "列出发现的问题（按严重程度排序）",
    "给出是否通过的整体结论",
  ],
  acceptanceCriteria: [
    {
      description: "审查报告已产出",
      required: true,
      validator: { type: "artifact_exists", outputKey: "review_report", artifactType: "document" },
    },
    {
      description: "语义审查通过（人工判断）",
      required: false,
      validator: { type: "reviewer_verdict" },
    },
  ],
};

// ── Lookup ──────────────────────────────────────────────────────────────────

const ROLE_MAP: Record<AgentRole, RoleOutputContract> = {
  pm: PM_CONTRACT,
  ui: UI_CONTRACT,
  frontend: FRONTEND_CONTRACT,
  reviewer: REVIEWER_CONTRACT,
};

/** Resolve the standard contract for an agent role. */
export function getRoleContract(role: AgentRole): RoleOutputContract | undefined {
  return ROLE_MAP[role];
}

/** All available role contracts. */
export function getAllRoleContracts(): RoleOutputContract[] {
  return Object.values(ROLE_MAP);
}

// ── Role detection ─────────────────────────────────────────────────────────

const ROLE_CAPABILITY_KEYWORDS: Record<string, AgentRole> = {
  pm: "pm",
  product: "pm",
  planning: "pm",
  ui: "ui",
  designer: "ui",
  design: "ui",
  ux: "ui",
  frontend: "frontend",
  react: "frontend",
  builder: "frontend",
  engineer: "frontend",
  developer: "frontend",
  review: "reviewer",
  reviewer: "reviewer",
  qa: "reviewer",
  test: "reviewer",
};

/** Detect the most likely agent role from agent capabilities and name. */
export function detectAgentRole(capabilities: string[], name?: string): AgentRole | null {
  const keywords = [...capabilities, ...(name ? [name] : [])].map((s) => s.toLowerCase());
  // Check in priority order: frontend before ui (engineer > designer)
  const priority: AgentRole[] = ["frontend", "pm", "ui", "reviewer"];
  for (const role of priority) {
    for (const kw of keywords) {
      for (const [keyword, mapped] of Object.entries(ROLE_CAPABILITY_KEYWORDS)) {
        if (mapped === role && kw.includes(keyword)) return role;
      }
    }
  }
  return null;
}
