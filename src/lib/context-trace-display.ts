const labels: Record<string, string> = {
  pending: "待执行", running: "执行中", complete: "已完成", completed: "已完成", reported_complete: "已报告完成", failed: "失败", aborted: "已中止", skipped: "已跳过",
  verified: "已验证", rejected: "未通过", unverified: "未验证", not_verified: "未验证", passed: "通过", valid: "有效", invalid: "无效", diagnostic: "诊断记录",
  authoritative: "权威来源", accepted: "已采纳", reported: "Agent 自述", retrieved: "外部检索", unknown: "未知", insufficient: "证据不足",
  file_read: "读取文件", file_written: "修改文件", file_write: "修改文件", command_executed: "命令执行", test_executed: "测试执行", artifact_created: "创建产物", artifact_read: "读取产物", deployment_created: "部署产物", task_reported: "任务报告",
  files_discovered: "定位文件", files_searched: "搜索文件", browser_checked: "网页验收", git_inspected: "代码变更", job_status: "后台命令状态", web_source_read: "网页资料", web_searched: "联网搜索",
  task: "当前任务", constraint: "任务约束", upstream_input: "上游产物", workspace: "工作区", evidence_contract: "验收要求", failure: "失败原因", retrieved_history: "历史检索", fact: "关键信息", evidence: "执行证据", recent_message: "近期消息",
  budget: "预算不足", stale: "信息已过期", unrelated: "与任务无关"
};
export function traceLabel(value: string) { return labels[value] ?? value; }
