const TOOL_DISPLAY_NAMES: Readonly<Record<string, string>> = {
  read: "读取文件",
  write: "写入文件",
  edit: "文件修改",
  ls: "浏览文件",
  grep: "搜索内容",
  find: "查找文件",
  ask_user: "询问用户",
  bash: "执行命令",
  fs_glob: "查找文件",
  fs_search: "搜索内容",
  job_start: "启动后台命令",
  job_read: "查看命令输出",
  job_wait: "等待命令完成",
  job_cancel: "取消后台命令",
  git_inspect: "检查代码变更",
  browser_check: "网页验收",
  web_fetch: "读取网页",
  web_search: "联网搜索",
  read_evidence: "读取执行证据",
  update_context_facts: "更新上下文事实",
  deploy_artifact: "部署产物",
  deploy_workspace: "部署工作区",
  fs_list: "浏览文件",
  fs_mkdir: "创建目录",
  fs_read: "读取文件",
  fs_write: "写入文件",
  fs_patch: "文件修改",
  plan_tasks: "拆分任务",
  list_team_members: "查询团队成员",
  read_artifact: "读取产物",
  read_attachment: "读取附件",
  report_task_result: "汇报任务结果",
  write_artifact: "创建产物"
};

export function getToolDisplayName(toolName: string): string {
  return TOOL_DISPLAY_NAMES[toolName] ?? toolName;
}
