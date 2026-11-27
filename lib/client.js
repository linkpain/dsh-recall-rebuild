/**
 * 记忆识海 · 客户端面板(DSH Web GUI 插件,预编译单文件)。
 *
 * 这个文件由宿主直接当脚本加载,形状固定:window.__ModuleLoader__.load({ id, factory })。
 * 没有构建步骤 —— 面板本体是一个 iframe,指向宿主 webServer 的同源路由
 * /recall-rebuild/sea/(静态页面 + 数据都在那边),所以这里只需要注册两个槽位:
 *
 * - 'main'              → 主区域整块面板(key = 面板 id);
 * - 'sidebar.panellist' → 左侧图标行(必须与 main 的 key 相同才能选中)。
 *
 * 为什么用 iframe 而不是把 Canvas 渲染器搬进 React:渲染器是零依赖的 ES 模块
 * (sea-core.js / sea-view.js),直接当 <script type="module"> 跑最省事,
 * 也不会和宿主的 React 版本、构建产物打架。
 *
 * 注册顺序有个硬约束(照抄 dsh-mcp-connector lib/client.js:3096 的注释):
 * main 必须先就绪,否则宿主会拒绝选中「缺页面」的侧边栏行。两个槽位的
 * inject 回调谁先触发不确定,所以侧边栏行要等 mainReady 之后再注册。
 */
window.__ModuleLoader__.load({
  id: 'dsh-recall-rebuild',
  factory: function (require) {
    var module = { exports: {} };
    var React = require('react');

    /** 面板 id:main 的 key 与 panellist 的 id 必须一致。 */
    var PANEL_ID = 'recall-rebuild-sea';
    /** 同源路由(与宿主 src/web.ts 的 SEA_ROUTE_PREFIX 对应)。 */
    var PANEL_URL = '/recall-rebuild/sea/';

    function SeaPanel() {
      return React.createElement('iframe', {
        title: '记忆识海',
        src: PANEL_URL,
        // allow-same-origin 让面板里的 fetch('./data') 走同源;
        // 不给 allow-scripts 以外的权限:面板不需要弹窗、下载、表单。
        sandbox: 'allow-scripts allow-same-origin',
        style: {
          width: '100%',
          height: '100%',
          border: 0,
          display: 'block',
          background: '#05070d',
        },
      });
    }

    /** 侧边栏图标:一个「星点 + 连线」的极简标记。 */
    function SeaIcon(props) {
      var size = (props && props.size) || 16;
      return React.createElement(
        'svg',
        {
          width: size,
          height: size,
          viewBox: '0 0 24 24',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.4,
          strokeLinecap: 'round',
        },
        React.createElement('path', { d: 'M6 8.5 11 6l4.5 3.5-1.5 5L8.5 16z' }),
        React.createElement('path', { d: 'M11 6V3.5M15.5 9.5 19 8M14 14.5 16.5 18M8.5 16 5.5 19' }),
        React.createElement('circle', { cx: 6, cy: 8.5, r: 1.1, fill: 'currentColor', stroke: 'none' }),
        React.createElement('circle', { cx: 11, cy: 6, r: 1.1, fill: 'currentColor', stroke: 'none' }),
        React.createElement('circle', { cx: 15.5, cy: 9.5, r: 1.1, fill: 'currentColor', stroke: 'none' }),
        React.createElement('circle', { cx: 14, cy: 14.5, r: 1.1, fill: 'currentColor', stroke: 'none' }),
        React.createElement('circle', { cx: 8.5, cy: 16, r: 1.1, fill: 'currentColor', stroke: 'none' }),
      );
    }

    module.exports = {
      inject: ['slots'],
      apply: function (ctx) {
        // 两个槽位是否就绪是独立事件,谁先到不确定;侧边栏行要等 main 就绪。
        var mainReady = false;
        var panelListReady = false;
        var entryDispose = null;

        var syncEntry = function () {
          if (mainReady && panelListReady && entryDispose === null) {
            entryDispose = ctx.slots.register(
              { name: 'sidebar.panellist', id: PANEL_ID, order: 30, label: '记忆识海' },
              SeaIcon,
            );
          } else if (!(mainReady && panelListReady) && entryDispose !== null) {
            entryDispose();
            entryDispose = null;
          }
        };

        ctx.slots.inject('main', function () {
          var disposeMain = ctx.slots.register(
            { name: 'main', key: PANEL_ID },
            SeaPanel,
          );
          mainReady = true;
          syncEntry();
          return function () {
            mainReady = false;
            syncEntry();
            disposeMain();
          };
        });

        ctx.slots.inject('sidebar.panellist', function () {
          panelListReady = true;
          syncEntry();
          return function () {
            panelListReady = false;
            syncEntry();
          };
        });
      },
    };
    return module.exports;
  },
});
