/**
 * self-memorycontrol — browser half (web only).
 *
 * Registers a "Memory" tab in the conversation view ring, next to chat and
 * trajectory. The tab talks to the host half through the JSON API at
 * POST /plugins/self-memorycontrol/api (see lib/web.js).
 *
 * This file IS the built bundle: it is written in the lazy-CJS format the web
 * module loader expects (window.__ModuleLoader__.load({ id, factory })), so the
 * package needs no build step and no prepare script — `dsh plugin add` from a
 * git URL works without pnpm allowBuilds.
 */
if (typeof window !== "undefined" && window.__ModuleLoader__) {
  window.__ModuleLoader__.load({
    id: "self-memorycontrol",
    factory: function (require) {
      "use strict";
      var module = { exports: {} };
      var exports = module.exports;
      Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

      var react = require("react");
      var useState = react.useState;
      var useEffect = react.useEffect;
      var h = react.createElement;

      var NS = "selfMemory";

      var KINDS = ["fact", "decision", "preference", "knowledge", "todo", "note", "context", "person", "project", "code", "other"];
      var SCOPES = ["auto", "workspace", "global", "all"];

      var dicts = {
        zh: {
          "view.memory": "记忆",
          "search.placeholder": "搜索记忆（支持 kind: tag: importance:>3 …）",
          "search": "搜索",
          "new": "新建",
          "save": "保存",
          "title": "标题",
          "kind": "类型",
          "tags": "标签（逗号分隔）",
          "importance": "重要度 1-5",
          "content": "内容",
          "cancel": "取消",
          "delete": "删除",
          "confirmDelete": "确定删除这条记忆？",
          "loading": "加载中…",
          "empty": "还没有记忆。点“新建”手动保存，或让助手用 memory_save 保存。",
          "error": "出错了",
          "stats": "共 {total} 条",
          "scope.auto": "自动",
          "scope.workspace": "当前工作区",
          "scope.global": "全局",
          "scope.all": "全部",
          "kind.fact": "事实",
          "kind.decision": "决策",
          "kind.preference": "偏好",
          "kind.knowledge": "知识",
          "kind.todo": "待办",
          "kind.note": "笔记",
          "kind.context": "上下文",
          "kind.person": "人物",
          "kind.project": "项目",
          "kind.code": "代码",
          "kind.other": "其他",
        },
        en: {
          "view.memory": "Memory",
          "search.placeholder": "Search memory (kind: tag: importance:>3 …)",
          "search": "Search",
          "new": "New",
          "save": "Save",
          "title": "Title",
          "kind": "Kind",
          "tags": "Tags (comma separated)",
          "importance": "Importance 1-5",
          "content": "Content",
          "cancel": "Cancel",
          "delete": "Delete",
          "confirmDelete": "Delete this memory entry?",
          "loading": "Loading…",
          "empty": "No memory yet. Create one with “New” or ask the agent to memory_save.",
          "error": "Something went wrong",
          "stats": "{total} entries",
          "scope.auto": "Auto",
          "scope.workspace": "Workspace",
          "scope.global": "Global",
          "scope.all": "All",
          "kind.fact": "Fact",
          "kind.decision": "Decision",
          "kind.preference": "Preference",
          "kind.knowledge": "Knowledge",
          "kind.todo": "Todo",
          "kind.note": "Note",
          "kind.context": "Context",
          "kind.person": "Person",
          "kind.project": "Project",
          "kind.code": "Code",
          "kind.other": "Other",
        },
      };

      function api(op, args, sessionId) {
        return fetch("/plugins/self-memorycontrol/api", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ op: op, args: args || {}, sessionId: sessionId || null }),
        })
          .then(function (r) { return r.json(); })
          .then(function (d) {
            if (d && d.error) throw new Error(d.error);
            return d;
          });
      }

      var styles = {
        root: { boxSizing: "border-box", flex: 1, minHeight: 0, display: "flex", flexDirection: "column", gap: "0.5em", padding: "1em", overflow: "auto" },
        toolbar: { display: "flex", gap: "0.5em", flexWrap: "wrap", alignItems: "center" },
        input: { flex: "1 1 14em", minWidth: "10em", padding: "0.4em 0.6em", borderRadius: "8px", border: "1px solid var(--dsw-alias-border-l2, #ddd)", background: "var(--dsw-alias-bg-base, #fff)", color: "var(--dsw-alias-label-primary, #111)", fontSize: "13px" },
        select: { padding: "0.4em 0.4em", borderRadius: "8px", border: "1px solid var(--dsw-alias-border-l2, #ddd)", background: "var(--dsw-alias-bg-base, #fff)", color: "var(--dsw-alias-label-primary, #111)", fontSize: "13px" },
        btn: { padding: "0.4em 0.8em", borderRadius: "8px", border: "1px solid var(--dsw-alias-border-l2, #ccc)", background: "var(--dsw-alias-interactive-bg-hover, #f0f0f0)", color: "var(--dsw-alias-label-primary, #111)", fontSize: "13px", cursor: "pointer" },
        error: { padding: "0.5em 0.8em", borderRadius: "8px", background: "var(--dsw-alias-state-error-primary, #fde8e8)", color: "var(--dsw-alias-state-error-primary, #b00020)", fontSize: "12px" },
        stats: { fontSize: "12px", opacity: 0.7, padding: "0 0.2em" },
        list: { display: "flex", flexDirection: "column", gap: "0.5em", flex: 1, minHeight: 0, overflow: "auto" },
        card: { border: "1px solid var(--dsw-alias-border-l1, #eee)", borderRadius: "10px", padding: "0.6em 0.8em", background: "var(--dsw-alias-bg-base, #fff)" },
        cardHead: { display: "flex", gap: "0.5em", alignItems: "center", cursor: "pointer", flexWrap: "wrap" },
        cardTitle: { fontWeight: 600, fontSize: "13px", flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
        badge: { fontSize: "11px", padding: "0.1em 0.5em", borderRadius: "999px", background: "var(--dsw-alias-interactive-bg-hover, #f0f0f0)", color: "var(--dsw-alias-label-secondary, #444)" },
        snippet: { fontSize: "12px", opacity: 0.85, marginTop: "0.35em", whiteSpace: "pre-wrap", wordBreak: "break-word" },
        detail: { fontSize: "12px", marginTop: "0.35em", whiteSpace: "pre-wrap", wordBreak: "break-word", maxHeight: "22em", overflow: "auto", padding: "0.5em", borderRadius: "8px", background: "var(--dsw-alias-interactive-bg-hover, #f6f6f6)" },
        cardFoot: { display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: "0.4em", gap: "0.5em" },
        meta: { fontSize: "11px", opacity: 0.6, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
        linkBtn: { fontSize: "11px", border: "none", background: "none", color: "var(--dsw-alias-state-error-primary, #b00020)", cursor: "pointer", padding: 0 },
        center: { textAlign: "center", padding: "2em", opacity: 0.6, fontSize: "13px" },
        form: { display: "flex", flexDirection: "column", gap: "0.5em", padding: "0.8em", borderRadius: "10px", border: "1px dashed var(--dsw-alias-border-l2, #ccc)" },
        row: { display: "flex", gap: "0.5em", flexWrap: "wrap", alignItems: "center" },
        textarea: { minHeight: "6em", padding: "0.4em 0.6em", borderRadius: "8px", border: "1px solid var(--dsw-alias-border-l2, #ddd)", background: "var(--dsw-alias-bg-base, #fff)", color: "var(--dsw-alias-label-primary, #111)", fontSize: "13px", fontFamily: "inherit", resize: "vertical" },
      };

      function MemoryTab(props) {
        var sessionId = props.sessionId;
        var t = props.t || function (key) { return (dicts.en[key] || key); };
        var s = useState({
          query: "", kind: "", scope: "auto",
          results: [], total: 0, loading: true, error: null,
          expanded: {}, details: {}, showForm: false,
          form: { title: "", kind: "note", tags: "", importance: "3", content: "" },
        });
        var state = s[0];
        var setState = s[1];

        function patch(partial) {
          setState(function (prev) { return Object.assign({}, prev, partial); });
        }

        function runSearch() {
          var args = { query: state.query || undefined, scope: state.scope, limit: 50, offset: 0 };
          if (state.scope === "all") delete args.scope;
          if (state.kind) args.kind = state.kind;
          patch({ loading: true, error: null });
          api("search", args, sessionId).then(function (d) {
            patch({ loading: false, results: d.hits || [], total: d.total || 0 });
          }).catch(function (e) {
            patch({ loading: false, error: String((e && e.message) || e) });
          });
        }

        useEffect(function () { runSearch(); /* initial load */ }, []);

        function toggle(id) {
          if (state.expanded[id]) {
            var ex = Object.assign({}, state.expanded);
            delete ex[id];
            patch({ expanded: ex });
            return;
          }
          var ex2 = Object.assign({}, state.expanded);
          ex2[id] = true;
          patch({ expanded: ex2 });
          api("get", { ids: [id] }, sessionId).then(function (d) {
            var det = Object.assign({}, state.details);
            det[id] = (d.entries || [])[0] || null;
            patch({ details: det });
          }).catch(function () { /* keep card closed */ });
        }

        function del(id) {
          if (!window.confirm(t("confirmDelete"))) return;
          api("delete", { ids: [id] }, sessionId).then(function () { runSearch(); })
            .catch(function (e) { patch({ error: String((e && e.message) || e) }); });
        }

        function submitSave(ev) {
          if (ev && ev.preventDefault) ev.preventDefault();
          var f = state.form;
          if (!f.content || !f.content.trim()) return;
          api("save", {
            title: f.title,
            kind: f.kind || "note",
            tags: f.tags.split(/[,，]/).map(function (x) { return x.trim(); }).filter(Boolean),
            importance: Number(f.importance) || 3,
            content: f.content,
            scope: "workspace",
          }, sessionId).then(function () {
            patch({
              showForm: false,
              form: { title: "", kind: "note", tags: "", importance: "3", content: "" },
            });
            runSearch();
          }).catch(function (e) { patch({ error: String((e && e.message) || e) }); });
        }

        function setFormField(key) {
          return function (e) {
            var form = Object.assign({}, state.form);
            form[key] = e.target.value;
            patch({ form: form });
          };
        }

        var kindOptions = KINDS.map(function (k) {
          return h("option", { key: k, value: k }, t("kind." + k));
        });
        var scopeOptions = SCOPES.map(function (sc) {
          return h("option", { key: sc, value: sc }, t("scope." + sc));
        });

        return h("div", { style: styles.root },
          h("div", { style: styles.toolbar },
            h("input", {
              style: styles.input,
              placeholder: t("search.placeholder"),
              value: state.query,
              onChange: function (e) { patch({ query: e.target.value }); },
              onKeyDown: function (e) { if (e.key === "Enter") runSearch(); },
            }),
            h("select", { style: styles.select, value: state.kind, onChange: function (e) { patch({ kind: e.target.value }); } },
              h("option", { key: "", value: "" }, "—"),
              kindOptions,
            ),
            h("select", { style: styles.select, value: state.scope, onChange: function (e) { patch({ scope: e.target.value }); } }, scopeOptions),
            h("button", { style: styles.btn, onClick: runSearch }, t("search")),
            h("button", { style: styles.btn, onClick: function () { patch({ showForm: !state.showForm }); } }, t("new")),
          ),
          state.error ? h("div", { style: styles.error }, state.error) : null,
          state.showForm ? h("form", { style: styles.form, onSubmit: submitSave },
            h("div", { style: styles.row },
              h("input", { style: Object.assign({}, styles.input, { flex: "2 1 12em" }), placeholder: t("title"), value: state.form.title, onChange: setFormField("title") }),
              h("select", { style: styles.select, value: state.form.kind, onChange: setFormField("kind") }, kindOptions),
              h("input", { style: Object.assign({}, styles.input, { flex: "1 1 8em" }), placeholder: t("importance"), value: state.form.importance, onChange: setFormField("importance") }),
            ),
            h("input", { style: styles.input, placeholder: t("tags"), value: state.form.tags, onChange: setFormField("tags") }),
            h("textarea", { style: styles.textarea, placeholder: t("content"), value: state.form.content, onChange: setFormField("content") }),
            h("div", { style: styles.row },
              h("button", { style: styles.btn, type: "submit" }, t("save")),
              h("button", { style: styles.btn, type: "button", onClick: function () { patch({ showForm: false }); } }, t("cancel")),
            ),
          ) : null,
          h("div", { style: styles.stats }, t("stats").replace("{total}", String(state.total))),
          h("div", { style: styles.list },
            state.loading ? h("div", { style: styles.center }, t("loading"))
              : state.results.length === 0 ? h("div", { style: styles.center }, t("empty"))
              : state.results.map(function (hit) {
                  var expanded = Boolean(state.expanded[hit.id]);
                  var detail = state.details[hit.id];
                  var tagsText = (hit.tags && hit.tags.length ? " · " + hit.tags.join(", ") : "");
                  return h("div", { key: hit.id, style: styles.card },
                    h("div", { style: styles.cardHead, onClick: function () { toggle(hit.id); } },
                      h("span", { style: styles.cardTitle }, hit.title || hit.id),
                      h("span", { style: styles.badge }, hit.kind),
                      h("span", { style: styles.badge }, "★" + hit.importance),
                    ),
                    expanded
                      ? (detail ? h("div", { style: styles.detail }, detail.content || "") : h("div", { style: styles.center }, t("loading")))
                      : h("div", { style: styles.snippet }, hit.snippet || ""),
                    h("div", { style: styles.cardFoot },
                      h("span", { style: styles.meta }, ((hit.updatedAt || "").slice(0, 10)) + tagsText),
                      h("button", { style: styles.linkBtn, onClick: function () { del(hit.id); } }, t("delete")),
                    ),
                  );
                }),
          ),
        );
      }

      exports.inject = ["slots", "locale"];
      exports.apply = function (ctx) {
        ctx.effect(function () { return ctx.locale.register(NS, dicts); }, "self-memorycontrol: dictionaries");
        var t = ctx.locale.bind(NS);
        ctx.slots.inject("conversation.view", function () {
          return ctx.slots.register({
            name: "conversation.view",
            id: "self-memorycontrol",
            order: 30,
            locale: NS,
            label: function () { return t("view.memory"); },
            inject: function (sessionId) { return { sessionId: String(sessionId) }; },
          }, MemoryTab);
        });
      };
      // lazy-CJS 兼容补丁：本 DSH 加载器要求 factory 返回 module.exports
      return module.exports;
    },
  });
}
