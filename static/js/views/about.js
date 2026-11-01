export async function render(el) {
  el.innerHTML = `
    <div class="about-hero">
      <div class="eyebrow">Data & Method</div>
      <h1>把公募持仓拆开来看</h1>
      <p>FundScope 是一个本地运行的中国公募基金分析看板。它不做净值预测，也不推荐买卖，而是把公开披露的季报、持有人数据与基金经理定期报告整理成可验证的结构：基金经理在买什么、公募整体在抱团什么、机构与内部资金占比如何变化、经理在管产品是否重叠、你的组合穿透后到底重叠了多少。</p>
      <div class="chip-row mt-16">
        <span class="badge badge-teal">全市场季报聚合</span>
        <span class="badge badge-teal">4433 筛选</span>
        <span class="badge badge-teal">组合保存与回测</span>
        <span class="badge badge-teal">相关性与重叠度</span>
        <span class="badge badge-teal">持有人结构与自购代理</span>
        <span class="badge badge-teal">经理任期与年报观点</span>
        <span class="badge badge-teal">深色 / 浅色</span>
      </div>
    </div>

    <div class="grid">
      <div class="card span-6">
        <div class="card-head"><div><h3 class="card-title">数据来源</h3><p class="card-sub">全部为公开数据，经本地 SQLite 缓存</p></div></div>
        <div class="card-body">
          <table class="source-table">
            <thead><tr><th>来源</th><th>用途</th></tr></thead>
            <tbody>
              <tr><td>天天基金</td><td>基金净值、前十大持仓、行业配置、规模变动、持有人结构、份额申赎、基金经理、评级与申购费率</td></tr>
              <tr><td>基金定期报告公告</td><td>季报 / 中报 / 年报原文中的投资策略与运作分析、业绩表现、后市展望</td></tr>
              <tr><td>东方财富数据中心</td><td>全市场基金重仓股聚合、基金公司管理规模</td></tr>
              <tr><td>雪球基金</td><td>基金基础信息、阶段业绩与同类排名</td></tr>
              <tr><td>东方财富 F10</td><td>个股所属申万一级 / 二级行业</td></tr>
              <tr><td>腾讯行情</td><td>股票最新价、涨跌幅、PE、PB、总市值 / 流通市值</td></tr>
              <tr><td>巨潮资讯</td><td>基金报告期行业配置（证监会门类）</td></tr>
            </tbody>
          </table>
        </div>
      </div>
      <div class="card span-6">
        <div class="card-head"><div><h3 class="card-title">必须知道的口径</h3><p class="card-sub">看板里的数字不代表完整真相</p></div></div>
        <div class="card-body">
          <div class="insights">
            <div class="insight warn"><span class="insight-dot"></span><div><div class="insight-title">季报只披露前十大</div><div class="insight-text">一季报、三季报仅披露前十大重仓股；中报、年报披露全部持仓。看板的单基金持仓、组合穿透均以前十大为口径。</div></div></div>
            <div class="insight warn"><span class="insight-dot"></span><div><div class="insight-title">重仓股透视统一前十大口径</div><div class="insight-text">Q2 / Q4 的全量披露会让“持有基金数”显著高于 Q1 / Q3。重仓股透视不再混用全量数据，而是从每只基金的中报 / 年报持仓中还原前十大，再按相邻季度计算真实环比；市场全景的全量披露跳变仍用同比观察。</div></div></div>
            <div class="insight warn"><span class="insight-dot"></span><div><div class="insight-title">持仓天然滞后</div><div class="insight-text">报告期结束后 15 个工作日才披露，基金经理可能已调仓。持仓分析用于理解风格与结构，不等于实时仓位。</div></div></div>
            <div class="insight warn"><span class="insight-dot"></span><div><div class="insight-title">内部持有 ≠ 基金公司自购</div><div class="insight-text">“内部持有”是基金公司员工/管理层持有本基金份额的公开披露口径，是接近“自购”的代理指标，不等同于基金公司用自有资金申购；机构占比变化也可能来自场内交易或份额锁定。</div></div></div>
            <div class="insight info"><span class="insight-dot"></span><div><div class="insight-title">收益与任期口径</div><div class="insight-text">曲线统一使用“区间累计收益率（起点 0%）”，风险指标基于累计净值；夏普按 1.5% 无风险利率年化。经理任期收益按任职起始日切分，年化为几何年化；沪深300 基准仅覆盖可获取的行情区间，未覆盖任期会明确标注。</div></div></div>
            <div class="insight info"><span class="insight-dot"></span><div><div class="insight-title">定期报告为原文摘录</div><div class="insight-text">季报 / 年报观点来自公告原文，按“投资策略与运作分析、业绩表现、后市展望”分段提取；不同基金的披露详略不同，年报可能比季报多出展望段落。公告正文缺失时会回退为“暂无原文”。</div></div></div>
          </div>
        </div>
      </div>
    </div>

    <div class="about-section">
      <h2 class="section-title">功能地图</h2>
      <div class="about-grid">
        <div class="about-tile"><h4>市场全景</h4><p>全市场重仓股聚合、公募抱团榜、行业配置、基金公司规模与共识度同比变化。</p></div>
        <div class="about-tile"><h4>基金筛选</h4><p>按类型、评级、费率、收益、规模、机构占比、内部持有、经理年限与在管规模筛选；4433 自动标记，并标注持有人快照覆盖。</p></div>
        <div class="about-tile"><h4>基金档案</h4><p>累计收益与区间回撤、年度收益、前十大重仓、行业暴露、规模、持有人、经理任期超额与年报观点。</p></div>
        <div class="about-tile"><h4>组合工坊</h4><p>多基金穿透合并、行业暴露、相关性矩阵、重叠度与诊断；支持保存组合、四类再平衡回测、沪深300基准、Beta/Alpha 与收益归因。</p></div>
        <div class="about-tile"><h4>重仓股透视</h4><p>统一前十大口径，从个股反查基金数与市值的真实环比并支持升降序、前十大市值占比、全市场排名分位、季度轨迹、同行业对比与个股价格风险。</p></div>
        <div class="about-tile"><h4>持有人结构</h4><p>机构 / 个人 / 内部持有趋势、自购代理信号、份额申赎与全市场持有人结构对照。</p></div>
        <div class="about-tile"><h4>基金经理</h4><p>在管产品收益、风格指纹、相关性、重仓重叠、组合协同诊断，以及最新季报 / 年报原文观点。</p></div>
        <div class="about-tile"><h4>持有人筛选</h4><p>基金筛选支持机构占比、内部持有、规模、经理年限与经理在管规模等维度，并标注持有人快照覆盖率。</p></div>
        <div class="about-tile"><h4>本地缓存</h4><p>SQLite 持久化快照 + 内存缓存 + gzip，页面响应不依赖上游实时可用性。</p></div>
      </div>
    </div>

    <div class="about-section">
      <h2 class="section-title">设计参考：站在开源项目的肩膀上</h2>
      <p class="about-text">在动手前与迭代中，我系统检索了 GitHub 上与中国公募基金分析相关的项目，取长补短：数据层以 AKShare、efinance 为参照，组合穿透参考 xalpha，风险诊断与自托管思路参考 ZFundPilot，4433 与经理筛选参考 investool，机构占比与经理横向参考 taxue-invest，持有人结构与“机构占比变化未必是申购”的辨析参考 fund-guy-skill。本轮新增的持有人结构与自购代理、同经理在管产品与性能缓存均来自这些项目的启发。</p>
      <div class="about-grid mt-16">
        <a class="ref-card" href="https://github.com/refraction-ray/xalpha" target="_blank" rel="noreferrer">
          <h4>refraction-ray / xalpha <span class="repo">GitHub ↗</span></h4>
          <p>基金投资管理引擎。借鉴其“组合底层持仓穿透”的思路：把基金权重映射到股票与行业，得到等效股票集中度。</p>
        </a>
        <a class="ref-card" href="https://github.com/Euzohn/ZFundPilot" target="_blank" rel="noreferrer">
          <h4>Euzohn / ZFundPilot <span class="repo">GitHub ↗</span></h4>
          <p>自托管基金组合分析与风险管理。借鉴其交易记录、收益风险与结构优化并重的产品结构，以及“组合体检”的呈现方式。</p>
        </a>
        <a class="ref-card" href="https://github.com/hexliulab/fund-analysis-agents" target="_blank" rel="noreferrer">
          <h4>hexliulab / fund-analysis-agents <span class="repo">GitHub ↗</span></h4>
          <p>多智能体基金分析。借鉴其把研究拆成“基本面、持仓、风险、交易”多视角的组织方式，本看板以规则化诊断替代大模型。</p>
        </a>
        <a class="ref-card" href="https://github.com/akfamily/akshare" target="_blank" rel="noreferrer">
          <h4>akfamily / AKShare <span class="repo">GitHub ↗</span></h4>
          <p>开源财经数据接口库。基金列表、排行与部分档案数据直接使用其接口；行情与行业映射在项目内做了独立适配。</p>
        </a>
        <a class="ref-card" href="https://github.com/ZenghaoZheng/Alipay-Fund-Investment-Recommendations" target="_blank" rel="noreferrer">
          <h4>Alipay Fund Recommendations <span class="repo">GitHub ↗</span></h4>
          <p>AI 基金诊断与策略系统。借鉴其“先诊断、再决策”的交互顺序，以及把关键指标前置到首屏的信息架构。</p>
        </a>
        <a class="ref-card" href="https://github.com/wbh604/fund-guy-skill" target="_blank" rel="noreferrer">
          <h4>wbh604 / fund-guy-skill <span class="repo">GitHub ↗</span></h4>
          <p>基金经理 Alpha 分析。借鉴“拥挤度、稀缺度、规模容量”的观察维度，落成市场抱团榜与个股拥挤度指标。</p>
        </a>
        <a class="ref-card" href="https://github.com/Sebastian6848/GoFundBot" target="_blank" rel="noreferrer">
          <h4>Sebastian6848 / GoFundBot <span class="repo">GitHub ↗</span></h4>
          <p>Flask + Vue 的基金分析与可视化工具。借鉴其轻量自托管与“数据 + 图表 + 说明”一体化的产品形态。</p>
        </a>
        <a class="ref-card" href="https://github.com/hzm0321/real-time-fund" target="_blank" rel="noreferrer">
          <h4>hzm0321 / real-time-fund <span class="repo">GitHub ↗</span></h4>
          <p>实时基金估值追踪。其“盘中估值”提醒了本看板在季报滞后之外补充实时行情的必要性，个股价格与估值因此接入行情快照。</p>
        </a>
        <a class="ref-card" href="https://github.com/axiaoxin-com/investool" target="_blank" rel="noreferrer">
          <h4>axiaoxin-com / investool <span class="repo">GitHub ↗</span></h4>
          <p>Golang 实现的 4433 基金筛选、基金持仓相似度、股票选基与基金经理筛选。借鉴其“同经理多选一”的横向比较视角。</p>
        </a>
        <a class="ref-card" href="https://github.com/taxueseek/taxue-invest" target="_blank" rel="noreferrer">
          <h4>taxueseek / taxue-invest <span class="repo">GitHub ↗</span></h4>
          <p>多数据源投资分析 skill。其“机构占比、经理在管、同类分位”的检查清单，直接启发了本次持有人结构与经理横向模块。</p>
        </a>
        <a class="ref-card" href="https://github.com/jackluson/chinese-fund-crawler" target="_blank" rel="noreferrer">
          <h4>jackluson / chinese-fund-crawler <span class="repo">GitHub ↗</span></h4>
          <p>中国场外基金数据爬取与汇总分析。借鉴其对基金档案、规模和定期报告的整理方式。</p>
        </a>
        <a class="ref-card" href="https://github.com/Micro-sheep/efinance" target="_blank" rel="noreferrer">
          <h4>Micro-sheep / efinance <span class="repo">GitHub ↗</span></h4>
          <p>基金、股票、债券数据接口库。作为数据层备选思路，强化了本项目的抓取降级与本地缓存设计。</p>
        </a>
        <a class="ref-card" href="https://github.com/piginzoo/fund_analysis" target="_blank" rel="noreferrer">
          <h4>piginzoo / fund_analysis <span class="repo">GitHub ↗</span></h4>
          <p>基金数据爬取、定投分析与 CAPM/Alpha 计算。其把基金分析拆成数据、指标、比较的思路，启发了经理产品业绩与报告观点模块。</p>
        </a>
        <a class="ref-card" href="https://github.com/eeshsaxena/smart-money-tracker" target="_blank" rel="noreferrer">
          <h4>smart-money-tracker <span class="repo">GitHub ↗</span></h4>
          <p>基金经理想法聚类、风格指纹、重仓漂移与组合重叠。本看板的“经理风格指纹 / 在管产品重叠”直接参考了其分析框架。</p>
        </a>
      </div>
    </div>

    <div class="about-section">
      <h2 class="section-title">技术实现</h2>
      <div class="grid">
        <div class="card span-6">
          <div class="card-body about-text">
            <p><strong>后端：</strong>Python 3 · Flask · SQLite。数据抓取、指标计算与 API 分层；外部接口失败时回退到本地缓存。</p>
            <p><strong>前端：</strong>原生 ES Modules · ECharts 5 · 深色 / 浅色双主题 design tokens；无前端构建步骤，静态文件直接由 Flask 提供。</p>
            <p><strong>性能：</strong>内存缓存基金列表、经理索引、规模与行情；市场 / 基金 / 重仓股 / 经理 payload 持久化到 SQLite；API JSON 启用 gzip，静态 JS / CSS 采用协商缓存。</p><p><strong>回测与风险：</strong>净值按北京时间校正后与沪深300对齐；组合回测支持不再平衡 / 月度 / 季度 / 年度四种频率，输出年化收益、波动、夏普、卡玛、最大回撤、超额、Beta、Alpha、跟踪误差、信息比率与索提诺。</p>
            <p><strong>扩展数据：</strong>持有人快照按规模优先构建，经理索引覆盖 27,865 个基金代码；定期报告正文从天天基金公告接口获取，优先全文、失败时回退分页。</p>
            <p><strong>缓存策略：</strong>基金列表 12h、全市场季报 2h（披露期）/ 7d（历史）、基金档案 6h、行情 30min、行业映射 7d、持有人结构 24h。</p>
            <p><strong>可复现：</strong>运行 <code>python scripts/warmup.py</code> 可预热全市场数据、快照与热门基金档案。</p>
          </div>
        </div>
        <div class="card span-6">
          <div class="card-body">
            <div class="callout">
              <strong>免责声明</strong><br/>
              本工具仅用于公开数据的研究与学习，不构成任何投资建议或收益承诺。基金历史业绩不代表未来表现；持仓数据存在披露滞后与口径差异，请以基金定期报告原文为准。
            </div>
            <div class="note mt-12">项目定位：一个可审计、可本地运行、结构清晰的公募基金研究工作台，而不是“选基神器”。</div>
          </div>
        </div>
      </div>
    </div>
  `;
}
