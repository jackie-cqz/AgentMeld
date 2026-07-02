const TOOL_DISPLAY_NAMES: Readonly<Record<string, string>> = {
  ask_user: "询问用户",
  bash: "执行命令",
  deploy_artifact: "部署产物",
  deploy_workspace: "部署工作区",
  fs_list: "浏览文件",
  fs_read: "读取文件",
  fs_write: "写入文件",
  plan_tasks: "拆分任务",
  read_artifact: "读取产物",
  read_attachment: "读取附件",
  report_task_result: "汇报任务结果",
  write_artifact: "创建产物"
};

export function getToolDisplayName(toolName: string): string {
  return TOOL_DISPLAY_NAMES[toolName] ?? toolName;
}
