// ---------------------------------------------------------------------------
// P2: Built-in Fact Definitions — high-frequency, stable, cross-project facts
//
// Only the most common fields are defined here; conversation-specific fields
// are dynamically defined per-conversation via conversation_fact_definitions.
// ---------------------------------------------------------------------------

export type FactValueType =
  | "string"
  | "number"
  | "boolean"
  | "color"
  | "string_array"
  | "json";

export type FactUpdatePolicy =
  | "replace"
  | "append"
  | "merge";

export interface FactDefinition {
  id: string;
  canonicalKey: string;
  namespace: string;
  entityType: string;
  property: string;
  valueType: FactValueType;
  updatePolicy: FactUpdatePolicy;
  description: string;
  aliases: string[];
  applicableTaskTags: string[];
  applicableAgentRoles: string[];
  origin: "builtin" | "conversation";
}

export const BUILTIN_FACT_DEFINITIONS: FactDefinition[] = [
  {
    id: "builtin_project_goal",
    canonicalKey: "project.goal",
    namespace: "project",
    entityType: "project",
    property: "goal",
    valueType: "string",
    updatePolicy: "replace",
    description: "当前项目的主要目标",
    aliases: ["project_goal", "项目目标", "产品目标"],
    applicableTaskTags: ["planning", "design", "implementation", "review"],
    applicableAgentRoles: ["conductor", "pm", "ui", "frontend", "reviewer"],
    origin: "builtin",
  },
  {
    id: "builtin_frontend_framework",
    canonicalKey: "technical.frontend.framework",
    namespace: "technical.frontend",
    entityType: "frontend",
    property: "framework",
    valueType: "string",
    updatePolicy: "replace",
    description: "前端技术框架",
    aliases: ["frontend_framework", "前端框架", "ui_framework"],
    applicableTaskTags: ["planning", "implementation", "review"],
    applicableAgentRoles: ["conductor", "frontend", "reviewer"],
    origin: "builtin",
  },
  {
    id: "builtin_ui_primary_color",
    canonicalKey: "ui.theme.primaryColor",
    namespace: "ui.theme",
    entityType: "global_theme",
    property: "primary_color",
    valueType: "color",
    updatePolicy: "replace",
    description: "应用全局主题主色",
    aliases: ["theme_color", "primary_color", "brand_color", "主色", "主题颜色"],
    applicableTaskTags: ["design", "implementation", "review"],
    applicableAgentRoles: ["conductor", "ui", "frontend", "reviewer"],
    origin: "builtin",
  },
  {
    id: "builtin_auth_required",
    canonicalKey: "feature.auth.required",
    namespace: "feature.auth",
    entityType: "authentication",
    property: "required",
    valueType: "boolean",
    updatePolicy: "replace",
    description: "产品是否需要登录或认证功能",
    aliases: ["auth_required", "login_required", "需要登录", "认证需求"],
    applicableTaskTags: ["planning", "implementation", "review"],
    applicableAgentRoles: ["conductor", "pm", "frontend", "reviewer"],
    origin: "builtin",
  },
];

/** Look up a builtin definition by id, canonical key, or alias. */
export function findBuiltinDefinition(query: string): FactDefinition | undefined {
  const q = query.toLowerCase();
  return BUILTIN_FACT_DEFINITIONS.find(
    (d) =>
      d.id === query ||
      d.canonicalKey === query ||
      d.aliases.some((a) => a.toLowerCase() === q)
  );
}
