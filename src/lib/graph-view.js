/**
 * 知识图谱的浏览器视图。
 *
 * 视觉与手感对齐 Obsidian 的 graph view：
 * - 节点半径按 `max(8, min(3*sqrt(degree+1), 30))` 定基准，随缩放一起变化（不是屏幕固定大小）；
 *   节点超过 90 个时改用更小的一套尺寸与更强的斥力，避免密集图挤成白团
 * - 标签在节点正下方居中，字号 12/11px，屏幕空间做碰撞剔除；全景下隐藏，放大后才显示；
 *   全景悬停只显示鼠标所在节点的名字，放大后标签保持显示、不因悬停消失
 * - 连续力模拟：中心引力 0.12、链接力 1、链接距离 250，节点靠斥力自然散开；
 *   另外用 forceCollide 保证初始布局里节点圆之间也有间隙，放大后不会互相压住
 * - 拖拽时钉住节点（fx/fy）并唤醒模拟（alphaTarget 0.3），松手后释放并自然冷却
 * - 悬停时平滑聚焦（进入 435ms、退出 300ms，与整页压暗同一时长和曲线）：悬停节点与它的边最亮，
 *   邻居节点保留 78%，其余节点与边几乎隐入背景
 *   （同时给 body 加 graph-focus，由 CSS 把页面上其余内容一起压暗，像熄灯只剩这一簇）
 * - 打开时按节点 created 时间依次弹出（约 3s），标签在节点完全出现后才显示
 * - 普通滚轮滚页面，Ctrl/⌘ + 滚轮才缩放（sigma 的 shared 手势模式）
 *
 * Obsidian 的模拟是自研 worker，这里用 d3-force 表达同一套力语义；参数按它的默认值校准。
 */

const LABEL_FONT = 'Inter, system-ui, sans-serif';

// Obsidian 的 getSize(): fNodeSizeMult * max(8, min(3*sqrt(weight+1), 30))
const NODE_MIN = 8;
const NODE_MAX = 30;

// 首帧（镜头 ratio=1）的屏幕像素半径范围。Obsidian 的基准是 8–30px，但那是全屏画布；
// 我们只有 ~750px 宽的区块，等比压到 5–18px（移动端 3.5–11px）。
const SCREEN_MIN = 5;
const SCREEN_MAX = 18;
const COMPACT_MIN = 3.5;
const COMPACT_MAX = 11;

// Obsidian graph 默认力参数。斥力按其 repelStrength 10 的比例校准到 d3 的电荷单位，
// 目标是「链接在屏幕上约 55–65px」——足够让 11/12px 的标签错开。
const LINK_DISTANCE = 250;
const LINK_STRENGTH = 1;
const CENTER_STRENGTH = 0.12;
const CHARGE_STRENGTH = -120;
const CHARGE_DISTANCE_MAX = 1600;

// 打开动画：按创建时间依次出现。慢一点更接近 Obsidian 打开图谱时的呼吸感。
const REVEAL_DURATION = 620;
const REVEAL_TOTAL = 3000;

// 标签只在放大到一定程度后才显示：初始全景里 150 个标签挤在一起会显得杂乱。
const LABEL_ZOOM_IN = 1.18;

/** 把 Obsidian 的 8–30 基准映射到区块里的屏幕像素半径。 */
function screenSize(degree, min = SCREEN_MIN, max = SCREEN_MAX) {
  const base = Math.max(NODE_MIN, Math.min(3 * Math.sqrt(degree + 1), NODE_MAX));
  return min + ((base - NODE_MIN) / (NODE_MAX - NODE_MIN)) * (max - min);
}

function shortenLabel(label, maxWidth) {
  const context = shortenLabel.context || (shortenLabel.context = document.createElement('canvas').getContext('2d'));
  context.font = `12px ${LABEL_FONT}`;
  if (context.measureText(label).width <= maxWidth) return label;

  const chars = Array.from(label);
  let low = 0;
  let high = chars.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    const candidate = `${chars.slice(0, middle).join('')}…`;
    if (context.measureText(candidate).width <= maxWidth) low = middle;
    else high = middle - 1;
  }
  return `${chars.slice(0, low).join('')}…`;
}

/**
 * 挂载图谱。返回 { destroy }。
 * @param {{host: HTMLElement, data: {nodes: any[], edges: any[]}, colors: Record<string,string>}} options
 */
export async function createGraphView({ host, data, colors }) {
  const [{ default: Sigma }, { default: Graph }, d3] = await Promise.all([
    import('sigma'),
    import('graphology'),
    import('d3-force'),
  ]);

  const { forceSimulation, forceLink, forceManyBody, forceCenter, forceCollide } = d3;
  const compact = host.clientWidth < 480;
  // 节点多的时候（demo 图谱 150 个）按原来的尺寸会挤成一个白团：缩小节点、拉开斥力，
  // 让每颗节点和连线都分得开。真实文章图谱节点少，保持原来的比例。
  const dense = data.nodes.length > 90;
  const maxLabelWidth = compact ? 104 : 156;
  const screenMin = compact ? COMPACT_MIN : dense ? 4 : SCREEN_MIN;
  const screenMax = compact ? COMPACT_MAX : dense ? 12 : SCREEN_MAX;
  const linkDistance = dense ? 320 : LINK_DISTANCE;
  const chargeStrength = dense ? -320 : CHARGE_STRENGTH;
  const pad = compact ? 52 : 72;
  const graph = new Graph({ multi: false, type: 'undirected' });
  const nodeCount = data.nodes.length;

  // 初始位置用黄金角螺旋铺开：比纯随机更均匀，也让第一帧的模拟收敛更快。
  const seedRadius = 40 * Math.sqrt(nodeCount);
  data.nodes.forEach((node, index) => {
    const angle = index * 2.399963229728653;
    const radius = seedRadius * Math.sqrt((index + 0.5) / nodeCount);
    const isTag = node.type === 'tag';
    graph.addNode(node.key, {
      x: Math.cos(angle) * radius,
      y: Math.sin(angle) * radius,
      size: screenSize(node.degree, screenMin, screenMax),
      label: shortenLabel(node.label, maxLabelWidth),
      labelFull: node.label,
      color: isTag ? colors.textMuted : colors.accent,
      type: node.type,
      degree: node.degree,
      url: node.url ?? null,
      created: node.created ?? 0,
    });
  });

  for (const edge of data.edges) {
    if (!graph.hasNode(edge.source) || !graph.hasNode(edge.target)) continue;
    graph.addEdge(edge.source, edge.target, {
      key: edge.key,
      type: edge.type,
      size: 1,
    });
  }

  // d3 的节点对象与 graphology 解耦，tick 时再写回；拖拽时用 fx/fy 钉住。
  const simNodes = graph.nodes().map((key) => {
    const attrs = graph.getNodeAttributes(key);
    return { id: key, key, x: attrs.x, y: attrs.y, size: attrs.size };
  });
  const simLinks = graph
    .edges()
    .map((key) => {
      const [source, target] = graph.extremities(key);
      return { source, target };
    });
  const simByKey = new Map(simNodes.map((node) => [node.key, node]));

  // 打开动画的状态。顺序按创建时间，同一时间的按 key 稳定排序，保证每次刷新一致。
  // 节点初始进度为 0（不可见），首帧渲染后开始推进；prefers-reduced-motion 下直接全显。
  const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
  const revealOrder = [...data.nodes]
    .filter((node) => graph.hasNode(node.key))
    .sort((a, b) => (a.created ?? 0) - (b.created ?? 0) || a.key.localeCompare(b.key));
  const revealStep = Math.min(24, Math.max(4, REVEAL_TOTAL / Math.max(1, revealOrder.length)));
  const revealDelays = new Map(revealOrder.map((node, index) => [node.key, index * revealStep]));
  const revealProgress = new Map(revealOrder.map((node) => [node.key, reduceMotion ? 1 : 0]));
  let revealStartedAt = 0;
  let revealFrame = 0;
  let revealing = !reduceMotion;
  let lastLabelRevealAt = 0;
  const easeOut = (p) => 1 - (1 - p) ** 3;
  const revealOf = (key) => revealProgress.get(key) ?? 1;

  const collision = forceCollide().strength(1).iterations(2);
  const simulation = forceSimulation(simNodes)
    .force('link', forceLink(simLinks).id((node) => node.id).distance(linkDistance).strength(LINK_STRENGTH))
    .force('charge', forceManyBody().strength(chargeStrength).distanceMax(CHARGE_DISTANCE_MAX).theta(0.9))
    .force('center', forceCenter(0, 0).strength(CENTER_STRENGTH))
    .force('collide', collision)
    .stop();

  // 先离线跑到基本稳定，再把位置写回 graphology——必须在创建 Sigma 之前写回，
  // 否则 autoRescale:"once" 会拿初始螺旋位置冻结取景范围，力稳定后的节点会跑到画布外。
  simulation.tick(240);

  // 碰撞力用来保证「放大后节点也不重叠」。d3 的坐标是 graph 空间，而节点尺寸是屏幕像素：
  // 按节点铺满画布的比例把像素半径换算回 graph 单位。布局会随碰撞撑开，所以分几轮
  // 重新估算比例再跑，最后一轮结束后节点之间至少留出 20% 的屏幕间隙。
  const estimateContentScale = () => {
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    for (const node of simNodes) {
      if (node.x < minX) minX = node.x;
      if (node.x > maxX) maxX = node.x;
      if (node.y < minY) minY = node.y;
      if (node.y > maxY) maxY = node.y;
    }
    const usableWidth = Math.max(1, host.clientWidth - pad * 2);
    const usableHeight = Math.max(1, host.clientHeight - pad * 2);
    return Math.max(0.02, Math.min(usableWidth / Math.max(1, maxX - minX), usableHeight / Math.max(1, maxY - minY)));
  };
  for (let pass = 0; pass < 3; pass++) {
    const scale = estimateContentScale();
    collision.radius((node) => (node.size * 1.2) / scale);
    simulation.alpha(0.6).tick(70);
  }

  for (const node of simNodes) {
    graph.mergeNodeAttributes(node.key, { x: node.x, y: node.y });
  }

  // 取景留白按标签宽度给：标签以节点为中心、最宽 104/156px，留白不够会贴着画布边缘被裁掉。
  let zoomFactor = 1;

  let hovered = null;
  let focused = null;

  // 悬停/聚焦高亮。切换不是瞬时的：focusProgress 在固定时长内平滑过渡，所有透明度
  // 都按它插值。淡出期间 focusKey 仍然保留，节点、边、标签才能一起慢慢退场。
  // 进入 435ms（画布高亮原 420ms 与整页压暗原 450ms 的平均值）；退出缩短到 300ms，
  // 比进入短约 31%，离场更利落。两边用同一条 S 曲线
  // （CSS 侧 cubic-bezier(0.3333, 0, 0.6667, 1) 等价 smoothstep），避免一个先到位、
  // 另一个还在走。
  let focusKey = null;
  let focusProgress = 0;
  let focusFrom = 0;
  let focusTarget = 0;
  let focusStartedAt = 0;
  let focusFrame = 0;
  let activeNeighbors = new Set();

  const FOCUS_IN_DURATION = 435;
  const FOCUS_OUT_DURATION = 300;
  const focusEase = (t) => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t));

  const stepFocus = (now) => {
    const duration = focusTarget === 1 ? FOCUS_IN_DURATION : FOCUS_OUT_DURATION;
    const elapsed = Math.min(1, (now - focusStartedAt) / duration);
    focusProgress = focusFrom + (focusTarget - focusFrom) * focusEase(elapsed);
    sigma.scheduleRefresh();
    if (elapsed < 1) {
      focusFrame = requestAnimationFrame(stepFocus);
      return;
    }
    focusProgress = focusTarget;
    focusFrame = 0;
    if (focusTarget === 0) {
      // 完全淡出后才丢掉高亮身份，标签恢复全量竞争。
      focusKey = null;
      activeNeighbors = new Set();
      computeVisibleLabels();
      sigma.scheduleRefresh();
    }
  };

  const setFocus = (key, target) => {
    if (key) {
      focusKey = key;
      activeNeighbors = new Set(graph.neighbors(key));
      computeVisibleLabels();
    }
    focusTarget = target;
    focusFrom = focusProgress;
    // 整页变暗交给 CSS 过渡。CSS 过渡要等到下一帧样式重算才真正开始，
    // 所以计时起点也放到下一帧：否则画布高亮会先跑掉一个主线程阻塞的时间，
    // 页面还在原地，看起来就是「节点先亮了、页面后暗」。
    document.body.classList.toggle('graph-focus', target === 1);
    if (focusFrame) cancelAnimationFrame(focusFrame);
    focusFrame = requestAnimationFrame((now) => {
      focusStartedAt = now;
      focusFrame = 0;
      stepFocus(now);
    });
    sigma.scheduleRefresh();
  };

  // 标签防重叠。Sigma 的 labelGrid 只按「每格显示几个」筛选，不看标签宽度：
  // 90px 的格子里可能放着一个 150px 宽的标签，相邻格子再放一个就叠上了。这里
  // 自己做屏幕空间的贪心碰撞剔除：悬停/聚焦节点 → 邻居 → 笔记 → 标签 → 度数，
  // 标签之间、标签与节点圆之间都留出空隙。结果写进 labelVisibility，Sigma 的
  // 网格因此完全不参与决策。
  const LABEL_MARGIN = 5; // 与 sigma 默认的节点→文字间距一致
  const LABEL_GAP = 4; // 标签彼此、标签与节点之间至少留的屏幕像素
  const CULL_CELL = 128; // 空间哈希边长

  const measureContext = document.createElement('canvas').getContext('2d');
  const measureCache = new Map();
  const measureLabel = (text, fontSize) => {
    const cacheKey = `${fontSize}|${text}`;
    let measured = measureCache.get(cacheKey);
    if (!measured) {
      measureContext.font = `${fontSize}px ${LABEL_FONT}`;
      const metrics = measureContext.measureText(text);
      measured = { width: metrics.width, height: fontSize };
      measureCache.set(cacheKey, measured);
    }
    return measured;
  };

  let visibleLabels = new Set();
  let labelsReady = false;

  const computeVisibleLabels = () => {
    const width = host.clientWidth;
    const height = host.clientHeight;
    if (!labelsReady || !width || !height) return;

    // 全景下不显示名字：所有标签一起挤会显得杂乱，放大到 LABEL_ZOOM_IN 后再参与竞争。
    // 全景悬停时只破例给鼠标所在的节点显示名字；放大后标签本来就全量显示，
    // 悬停不能让它们消失，所以只把活动节点提到队首。
    if (!focusKey && zoomFactor < LABEL_ZOOM_IN) {
      visibleLabels = new Set();
      return;
    }

    const active = focusKey;
    const zoomedIn = zoomFactor >= LABEL_ZOOM_IN;
    const candidates = [];
    for (const key of graph.nodes()) {
      // 全景悬停只显示活动节点；邻居和其他节点的名字都不抢舞台。
      if (active && !zoomedIn && key !== active) continue;
      // 还没蹦出来的节点不参与占位，也不显示标签。
      if (revealOf(key) < 1) continue;
      const attrs = graph.getNodeAttributes(key);
      const isTag = attrs.type === 'tag';
      candidates.push({
        key,
        attrs,
        isTag,
        pos: sigma.graphToViewport({ x: attrs.x, y: attrs.y }),
        radius: attrs.size * zoomFactor * (key === active ? 1.18 : 1),
        priority: key === active ? 0 : activeNeighbors.has(key) ? 1 : isTag ? 3 : 2,
      });
    }
    candidates.sort((a, b) => a.priority - b.priority || b.attrs.degree - a.attrs.degree);

    // 空间哈希：已占用的矩形按格子落桶，查询时只看覆盖到的格子。
    const buckets = new Map();
    const addBox = (box) => {
      for (let row = Math.floor(box.minY / CULL_CELL); row <= Math.floor(box.maxY / CULL_CELL); row++) {
        for (let col = Math.floor(box.minX / CULL_CELL); col <= Math.floor(box.maxX / CULL_CELL); col++) {
          const cellKey = `${row}:${col}`;
          const cell = buckets.get(cellKey);
          if (cell) cell.push(box);
          else buckets.set(cellKey, [box]);
        }
      }
    };
    const overlaps = (box) => {
      for (let row = Math.floor(box.minY / CULL_CELL); row <= Math.floor(box.maxY / CULL_CELL); row++) {
        for (let col = Math.floor(box.minX / CULL_CELL); col <= Math.floor(box.maxX / CULL_CELL); col++) {
          const cell = buckets.get(`${row}:${col}`);
          if (!cell) continue;
          for (const other of cell) {
            if (
              box.minX < other.maxX + LABEL_GAP &&
              box.maxX > other.minX - LABEL_GAP &&
              box.minY < other.maxY + LABEL_GAP &&
              box.maxY > other.minY - LABEL_GAP
            ) {
              return true;
            }
          }
        }
      }
      return false;
    };

    // 节点圆先占位：标签不压在别的节点上，视觉上更干净。
    for (const candidate of candidates) {
      const { pos, radius } = candidate;
      addBox({ minX: pos.x - radius, maxX: pos.x + radius, minY: pos.y - radius, maxY: pos.y + radius });
    }

    visibleLabels = new Set();
    for (const candidate of candidates) {
      const labelSize = candidate.isTag ? 11 : 12;
      const { width: labelWidth, height: labelHeight } = measureLabel(candidate.attrs.label, labelSize);
      const top = candidate.pos.y + candidate.radius + LABEL_MARGIN;
      const box = {
        minX: candidate.pos.x - labelWidth / 2,
        maxX: candidate.pos.x + labelWidth / 2,
        minY: top,
        maxY: top + labelHeight,
      };
      if (box.maxX < 0 || box.minX > width || box.maxY < 0 || box.minY > height) continue;
      if (overlaps(box)) continue;
      addBox(box);
      visibleLabels.add(candidate.key);
    }
  };

  const sigma = new Sigma(graph, host, {
    settings: {
      enableNodeDrag: true,
      itemSizesReference: 'screen',
      autoRescale: 'once',
      autoRescaleContent: 'positions',
      stagePadding: pad,
      minCameraRatio: 0.05,
      maxCameraRatio: 4,
      renderEdgeLabels: false,
      enableEdgeEvents: false,
      hideEdgesOnMove: false,
      doubleClickZoomingRatio: 1,
      // 滚轮默认还页面：只有 Ctrl/⌘ + 滚轮才缩放图谱（sigma 的 shared 手势模式）。
      // 触屏同理：单指滚动页面，双指才缩放图谱。
      gestureTarget: 'shared',
      // sigma 在 shared 模式下会对普通滚轮弹提示条；这里不需要，置空即静默。
      sharedGestureWheelMessage: '',
      sharedGestureAppleWheelMessage: '',
      sharedGestureTouchMessage: '',
    },
    nodeReducer: (key, displayData) => {
      const isTag = graph.getNodeAttribute(key, 'type') === 'tag';
      const inFocus = focusKey !== null;
      const isActive = key === focusKey;
      const isNeighbor = inFocus && activeNeighbors.has(key);
      const isFaded = inFocus && !isActive && !isNeighbor;
      // 打开动画：进度 0 → 1 时节点从 35% 大小、透明弹到完整大小、不透明。
      const progress = revealing ? revealOf(key) : 1;
      const revealScale = 0.35 + 0.65 * easeOut(progress);
      const revealOpacity = Math.min(1, progress * 1.7);
      // 相关节点比悬停节点和它的边略暗一点；无关节点几乎隐入背景。
      const focusOpacity = !inFocus
        ? 1
        : isActive
          ? 1
          : 1 - (isNeighbor ? 0.22 : 0.86) * focusProgress;
      return {
        labelColor: isTag ? colors.textDim : colors.textMuted,
        labelSize: isTag ? 11 : 12,
        color: isActive ? colors.text : isTag ? colors.textMuted : colors.accent,
        labelFont: LABEL_FONT,
        // 标签等节点完全出现后再显示，动画期间不抢视线。放大后的标签不随
        // 聚焦淡出而消失，否则悬停一下整张图的标题会突然空掉。
        labelVisibility: progress >= 1 && (isActive || visibleLabels.has(key)) ? 'visible' : 'hidden',
        labelPosition: 'below',
        backdropVisibility: 'hidden',
        // 平时为了排布会把标签截断；悬停/聚焦时独占舞台，显示完整标题。
        label: isActive
          ? (graph.getNodeAttribute(key, 'labelFull') ?? displayData.label)
          : displayData.label,
        size: displayData.size * zoomFactor * revealScale * (isActive ? 1.18 : 1),
        opacity: revealOpacity * focusOpacity,
        zIndex: isActive ? 2 : isNeighbor ? 1 : 0,
      };
    },
    edgeReducer: (key) => {
      const type = graph.getEdgeAttribute(key, 'type');
      const [source, target] = graph.extremities(key);
      // 边等两端都出现后才画出来，跟着较早的一端一起淡入。
      const gate = revealing ? Math.min(revealOf(source), revealOf(target)) : 1;
      const baseSize = (type === 'similar' ? 0.6 : 0.8) * zoomFactor;
      const baseOpacity = type === 'link' ? 0.85 : type === 'similar' ? 0.4 : 0.55;
      if (!focusKey) {
        return { color: colors.border, size: baseSize, opacity: baseOpacity * gate };
      }
      if (source === focusKey || target === focusKey) {
        // 悬停节点的边是全图最亮的一层：颜色直接拉到 accent，比邻居节点的 78% 不透明度更实。
        return {
          color: colors.accent,
          size: baseSize + (1.4 * zoomFactor - baseSize) * focusProgress,
          opacity: gate * (0.92 + 0.08 * focusProgress),
        };
      }
      return {
        color: colors.border,
        size: baseSize,
        opacity: baseOpacity * gate * (1 - 0.9 * focusProgress),
      };
    },
  });

  const camera = sigma.getCamera();
  let homeState = null;

  // 打开动画：每帧推进所有节点的进度，标签每 80ms 重算一次（够跟手，又不用每帧做碰撞剔除）。
  const startReveal = () => {
    revealStartedAt = performance.now();
    const step = (now) => {
      if (!revealing) return;
      let done = true;
      for (const [key, delay] of revealDelays) {
        const progress = Math.min(1, Math.max(0, (now - revealStartedAt - delay) / REVEAL_DURATION));
        revealProgress.set(key, progress);
        if (progress < 1) done = false;
      }
      if (now - lastLabelRevealAt >= 80) {
        lastLabelRevealAt = now;
        computeVisibleLabels();
      }
      sigma.scheduleRefresh();
      if (done) {
        revealing = false;
        computeVisibleLabels();
        sigma.scheduleRefresh();
        return;
      }
      revealFrame = requestAnimationFrame(step);
    };
    revealFrame = requestAnimationFrame(step);
  };

  sigma.on('afterRender', () => {
    if (!homeState) homeState = camera.getState();
    if (labelsReady) return;
    // 首帧渲染之后取景才稳定（autoRescale 在第一次 processNodes 时执行），
    // 这时算出的屏幕坐标才有效。先隐藏全部标签，下一帧一次性打开。
    labelsReady = true;
    computeVisibleLabels();
    sigma.scheduleRefresh();
    // 取景稳定后再开始逐个蹦出，避免动画期间镜头还在自动缩放。
    if (revealing) {
      // 打开动画期间让模拟保持一点残余热度：节点会继续被斥力轻轻推开、收敛，
      // 像 Obsidian 打开图谱时的力场感。alpha 很小，只会有小幅位移。
      simulation.alpha(0.12).restart();
      startReveal();
    }
  });

  // Obsidian 的 nodeScale = sqrt(1/zoom)：拉远时节点缩得比镜头慢，拉近时才变大。
  // sigma 的 screen 模式本身不随缩放变化，这里手动补上这个 sqrt 曲线。
  const updateZoomFactor = () => {
    if (!labelsReady) return;
    zoomFactor = Math.min(2.2, Math.max(0.6, Math.sqrt(1 / camera.ratio)));
    // 缩放会同时改变节点半径和屏幕间距，标签要重新竞争位置；跨过标签显示阈值时
    // 也必须刷新，否则「放大后才出现名字」不会生效。
    computeVisibleLabels();
    sigma.scheduleRefresh();
  };
  camera.on('updated', updateZoomFactor);

  // 模拟 tick → graphology → sigma。用 scheduleRefresh 合并到下一帧，避免每个 tick 都同步重绘。
  simulation.on('tick', () => {
    for (const node of simNodes) {
      if (!graph.hasNode(node.key)) continue;
      graph.setNodeAttribute(node.key, 'x', node.x);
      graph.setNodeAttribute(node.key, 'y', node.y);
    }
    computeVisibleLabels();
    sigma.scheduleRefresh();
  });

  // 布局在预跑阶段已经稳定，这里不再启动模拟：Obsidian 的图在空闲时也是静止的，
  // 只有拖拽（alphaTarget 0.3）会唤醒模拟。也避免布局继续膨胀、冲出已冻结的取景范围。
  const clearFocus = () => {
    focused = null;
    hovered = null;
    setFocus(null, 0);
    sigma.refresh();
  };

  sigma.on('enterNode', ({ node }) => {
    hovered = node;
    setFocus(node, 1);
    sigma.refresh();
  });
  sigma.on('leaveNode', () => {
    hovered = null;
    // 指针离开节点但还停在聚焦节点上时，回到聚焦节点的高亮。
    if (focused) setFocus(focused, 1);
    else setFocus(null, 0);
    sigma.refresh();
  });
  sigma.on('clickNode', async ({ node }) => {
    const attributes = graph.getNodeAttributes(node);
    if (attributes.url) {
      try {
        const { navigate } = await import('astro:transitions/client');
        await navigate(attributes.url);
      } catch {
        window.location.assign(attributes.url);
      }
      return;
    }
    focused = focused === node ? null : node;
    hovered = null;
    if (focused) setFocus(focused, 1);
    else setFocus(null, 0);
    sigma.refresh();
  });
  sigma.on('clickStage', () => {
    if (!focused && !hovered) return;
    clearFocus();
  });
  // 普通滚轮会滚动页面，节点从指针下移走但 sigma 收不到 mousemove，聚焦与整页压暗
  // 会卡在旧节点上。页面一滚动就收回高亮，别让整页停在被压暗的状态。
  const onPageScroll = () => {
    if (!focused && !hovered) return;
    clearFocus();
  };
  window.addEventListener('scroll', onPageScroll, { passive: true });
  sigma.on('doubleClickStage', ({ preventSigmaDefault }) => {
    preventSigmaDefault();
    if (homeState) {
      clearFocus();
      camera.animate(homeState, { duration: 450 });
    }
  });

  // 拖拽：钉住 + 唤醒模拟，松手释放。与 Obsidian 的 fx/fy + alphaTarget 协议一致。
  sigma.on('nodeDragStart', ({ node }) => {
    hovered = null;
    focused = null;
    setFocus(null, 0);
    const simNode = simByKey.get(node);
    if (simNode) {
      simNode.fx = simNode.x;
      simNode.fy = simNode.y;
    }
    simulation.alphaTarget(0.3).restart();
    sigma.refresh();
  });
  sigma.on('nodeDrag', ({ node }) => {
    const simNode = simByKey.get(node);
    if (!simNode) return;
    simNode.fx = graph.getNodeAttribute(node, 'x');
    simNode.fy = graph.getNodeAttribute(node, 'y');
  });
  sigma.on('nodeDragEnd', ({ node }) => {
    const simNode = simByKey.get(node);
    if (simNode) {
      simNode.fx = null;
      simNode.fy = null;
    }
    simulation.alphaTarget(0);
  });

  // 尺寸变化会改变图→屏幕的映射，标签需要重新占位。
  const resizeObserver = new ResizeObserver(() => {
    sigma.resize();
    computeVisibleLabels();
    sigma.scheduleRefresh();
  });
  resizeObserver.observe(host);

  return {
    sigma,
    graph,
    simulation,
    computeVisibleLabels,
    getVisibleLabels: () => visibleLabels,
    // 调试/测试用：打开动画进度、聚焦状态。
    getRevealProgress: (key) => revealOf(key),
    getRevealDelays: () => new Map(revealDelays),
    getFocusState: () => ({ focusKey, focusProgress, neighbors: [...activeNeighbors] }),
    destroy() {
      resizeObserver.disconnect();
      window.removeEventListener('scroll', onPageScroll);
      cancelAnimationFrame(revealFrame);
      cancelAnimationFrame(focusFrame);
      document.body.classList.remove('graph-focus');
      camera.removeListener('updated', updateZoomFactor);
      simulation.stop();
      sigma.kill();
    },
  };
}
