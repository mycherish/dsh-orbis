/**
 * Every user-facing string of the Workspace panel lives here.
 *
 * The panel is Chinese-first but keeps its strings in one object so a later
 * i18n pass only has to swap this file: components never inline copy, and the
 * English micro-labels (`stateEn`, `connectionEn`, stat keys) are kept
 * separate from the translated ones so a locale that has no equivalent can
 * fall back to a stable technical term.
 */
import type {
  OrbitActivityStatus,
  OrbitAgentState,
  OrbitFileKind,
  OrbitToolCategory,
} from '../../shared/protocol';
import type { OrbitConnection } from '../contracts';

export const LABELS = {
  panel: {
    /** Accessible name of the dialog itself. */
    ariaLabel: 'Caelum Orbis 工作区',
    product: 'Caelum Orbis',
    close: 'Close',
    closeTitle: '关闭面板',
    settings: '设置',
    settingsTitle: '显示设置',
    settingsHint: '即时生效',
    settingsAria: '动画设置',
    stageAria: '能量球显示区',
    canvasAria: 'Agent 3D 能量球',
    orbFallback: '3D 不可用 · 静态模式',
    orbFallbackAria: 'WebGL 不可用，显示静态状态球',
    legendTitle: '节点图例',
    legendMicro: 'nodes',
    streamTitle: '实时活动记录',
    streamAria: '实时活动记录列表',
    timelineLabel: '执行时间线',
    railAria: '执行时间线',
  },
  state: {
    idle: '待机',
    starting: '启动中',
    thinking: '思考中',
    preparing: '准备工具',
    executing: '执行中',
    responding: '回复中',
    waiting: '等待确认',
    quiet: '静默中',
    completed: '已完成',
    interrupted: '已中断',
    error: '出错',
  } satisfies Record<OrbitAgentState, string>,
  /** Secondary, technical form shown next to the Chinese state word. */
  stateEn: {
    idle: 'IDLE',
    starting: 'START',
    thinking: 'THINKING',
    preparing: 'PREP',
    executing: 'EXECUTING',
    responding: 'REPLYING',
    waiting: 'WAITING',
    quiet: 'QUIET',
    completed: 'DONE',
    interrupted: 'HALTED',
    error: 'ERROR',
  } satisfies Record<OrbitAgentState, string>,
  connection: {
    connecting: '连接中',
    open: '已连接',
    reconnecting: '重连中',
    closed: '已断开',
  } satisfies Record<OrbitConnection, string>,
  connectionEn: {
    connecting: 'LINKING',
    open: 'LIVE',
    reconnecting: 'RETRY',
    closed: 'OFFLINE',
  } satisfies Record<OrbitConnection, string>,
  /** Banner copy for the two degraded transports. */
  banner: {
    reconnecting: '与 Host 的连接中断，正在自动重连',
    closed: '连接已关闭，面板停留在最后一帧快照',
  } satisfies Partial<Record<OrbitConnection, string>>,
  /** Legend / badge words for the five visual node families. */
  category: {
    read: '读取',
    write: '写入',
    edit: '编辑',
    error: '异常',
    tool: '工具',
  },
  statusZh: {
    running: '进行中',
    success: '已完成',
    failed: '失败',
    cancelled: '已取消',
    unknown: '状态未知',
  } satisfies Record<OrbitActivityStatus, string>,
  /** Fallback words for file rows whose flavour the Host did not send. */
  fileKind: {
    read: '读取',
    write: '写入',
    edit: '编辑',
  } satisfies Record<OrbitFileKind, string>,
  /** The thirteen v2.0 categories, mirrored from the shared contract table. */
  toolKind: {
    reasoning: '模型处理中',
    file_read: '读取项目文件',
    file_write: '修改文件',
    command: '执行命令',
    search: '搜索代码或资料',
    build: '构建项目',
    test: '执行测试',
    api: '接口查询',
    database: '数据库操作',
    inspection: '检查与验证',
    approval: '等待审批',
    response: '组织答复',
    unknown: '执行其他操作',
  } satisfies Record<OrbitToolCategory, string>,
  empty: {
    loadingTitle: '正在唤醒 Caelum Orbis…',
    loadingHint: '等待首个状态快照',
    idleTitle: '等待 Agent 开始工作…',
    idleHint: '第一个事件到达后，执行轨迹会在这里实时浮现',
    railHint: '暂无事件',
  },
  stats: {
    turns: 'TURNS',
    tools: 'TOOLS',
    files: 'FILES',
    active: 'ACTIVE',
    fps: 'FPS',
    state: 'STATE',
    uptime: 'UPTIME',
  },
  /** Tooltips that spell out the stat keys in Chinese. */
  statsHint: {
    turns: '轮次',
    tools: '工具调用',
    files: '文件触碰',
    active: '进行中的工具',
    fps: '渲染帧率',
    state: 'Agent 状态',
    uptime: '会话时长',
  },
  units: {
    justNow: '刚刚',
    empty: '—',
    second: 's',
    minute: 'm',
    hour: 'h',
    day: 'd',
    milli: 'ms',
  },
  settings: {
    enabled: {
      label: '启用 Caelum Orbis',
      hint: '关闭后断开数据流、停止渲染并释放显存',
    },
    displayMode: {
      label: '显示模式',
      hint: '常驻卡片何时展开',
      options: { auto: '自动展开', compact: '始终紧凑', orb: '仅能量球' },
    },
    showHud: { label: '常驻进度卡', hint: '不打开工作区也能看到进度' },
    showActivity: { label: '活动列表', hint: '工作区右侧的实时记录' },
    showRecentActivity: { label: '最近活动', hint: 'HUD 中的最近 5 条活动' },
    showSilenceAlert: { label: '静默提醒', hint: '长时间无活动时在 HUD 提示' },
    showWorkspace: { label: '详细 Workspace', hint: '允许打开完整工作区面板' },
    animate: { label: '3D 动画', hint: '关闭后只保留静态球体' },
    fps: { label: '帧率', hint: '渲染帧率上限', options: { '30': '30', '60': '60' } },
    particles: {
      label: '粒子密度',
      hint: '越高越有能量流动感',
      options: { low: '低', medium: '中', high: '高' },
    },
    rings: { label: '轨道环', hint: '球体外围的环绕光圈' },
    glow: { label: '光效', hint: '辉光与泛光强度' },
    reduceMotion: {
      label: '减少动态',
      hint: '降低呼吸、脉冲与飘移',
      options: { system: '跟随系统', on: '开', off: '关' },
    },
    pauseWhenHidden: { label: '后台暂停', hint: '标签页隐藏时停止渲染' },
  },
} as const;

export type Labels = typeof LABELS;
