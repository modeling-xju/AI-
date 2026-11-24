# -*- coding: utf-8 -*-
"""语义归纳层：把结构证据变成人能读的名字与说明。

有可用大模型（环境变量配置）时走模型；没有时退化为基于标识符的启发式命名，
保证 demo 在离线环境下也能演示完整链路。
"""
import json
import os
import re
import urllib.error
import urllib.request

BASE_URL = os.environ.get("LLM_BASE_URL", "").rstrip("/")
API_KEY = os.environ.get("LLM_API_KEY", "")
MODEL = os.environ.get("LLM_MODEL", "")
TIMEOUT = float(os.environ.get("LLM_TIMEOUT", "25"))

VERBS = {
    "add": "添加", "insert": "新增", "create": "创建", "save": "保存", "update": "更新",
    "modify": "修改", "delete": "删除", "remove": "移除", "clear": "清空", "get": "查询",
    "find": "查找", "query": "查询", "list": "列出", "load": "读取", "fetch": "获取",
    "select": "查询", "count": "统计", "search": "检索", "check": "检查", "verify": "校验",
    "exist": "判断", "is": "是否", "has": "是否", "submit": "提交", "pay": "支付",
    "cancel": "取消", "confirm": "确认", "apply": "申请", "approve": "审批", "login": "登录",
    "logout": "登出", "register": "注册", "send": "发送", "receive": "接收", "generate": "生成",
    "build": "构建", "parse": "解析", "extract": "抽取", "convert": "转换", "format": "格式化",
    "next": "生成", "current": "查看", "describe": "描述", "recalculate": "计算",
    "view": "查看", "detail": "查看", "stock": "库存", "decrease": "扣减",
    "increase": "增加", "mark": "标记", "of": "查询", "items": "条目", "calculate": "计算",
    "set": "设置", "sync": "同步", "export": "导出", "import": "导入", "validate": "校验",
}

NOUNS = {
    "order": "订单", "product": "商品", "cart": "购物车", "item": "条目", "items": "条目",
    "user": "用户", "customer": "客户", "payment": "支付", "money": "金额", "price": "价格",
    "stock": "库存", "quantity": "数量", "count": "数量", "page": "分页", "list": "列表",
    "id": "编号", "name": "名称", "phone": "手机号", "status": "状态", "total": "总计",
    "line": "明细", "detail": "详情", "address": "地址", "code": "编号", "type": "类型",
    "date": "日期", "time": "时间", "amount": "金额", "result": "结果", "data": "数据",
    "info": "信息", "score": "评分", "file": "文件", "path": "路径", "node": "节点",
    # 管理后台类工程常见词（SpringBlade 起步）
    "role": "角色", "dept": "部门", "menu": "菜单", "tenant": "租户", "dict": "字典",
    "post": "岗位", "region": "区域", "param": "参数", "log": "日志", "auth": "认证",
    "token": "令牌", "scope": "权限", "client": "客户端", "api": "接口", "grant": "授权",
    "account": "账号", "resource": "资源", "notice": "通知", "task": "任务", "job": "任务",
}

CLASS_SUFFIXES = {"serviceimpl", "service", "controller", "mapper", "dao", "impl",
                  "feign", "client", "api", "util", "utils", "config", "entity", "dto",
                  "vo", "provider", "granter", "handler", "filter", "properties", "props",
                  "builder", "factory", "helper", "support", "wrapper", "converter"}

MODULE_STOP = {"名称", "手机号", "状态", "数量", "编号", "价格", "金额", "日期", "时间",
               "详情", "数据", "信息", "结果", "总计", "分页", "列表", "类型", "工具",
               "数据访问", "操作", "相关操作", "条目", "对象", "页面", "明细", "库存量"}

SPECIAL = {
    "next": "生成新编号", "current": "查看当前编号", "describe": "描述对象",
    "recalculate": "重新计算", "itemsOf": "查询条目", "markPaid": "标记订单已支付",
    "cancelOrder": "取消订单", "findOrder": "查找订单", "updateStatus": "更新订单状态",
}

WORDS_SPLIT = re.compile(r"[A-Z]+(?![a-z])|[A-Z]?[a-z]+|\d+")


def split_words(name):
    return [word.lower() for word in WORDS_SPLIT.findall(name or "") if word]


def available():
    return bool(BASE_URL and MODEL)


def status_text():
    if available():
        return "已接入大模型 %s（%s）" % (MODEL, BASE_URL)
    return "未配置大模型，使用启发式命名"


def chat(messages, temperature=0.2):
    if not available():
        raise RuntimeError("未配置大模型")
    payload = json.dumps({"model": MODEL, "messages": messages,
                          "temperature": temperature}).encode("utf-8")
    request = urllib.request.Request(
        BASE_URL + "/chat/completions", data=payload,
        headers={"Content-Type": "application/json",
                 "Authorization": "Bearer " + API_KEY})
    with urllib.request.urlopen(request, timeout=TIMEOUT) as response:
        data = json.loads(response.read().decode("utf-8"))
    return data["choices"][0]["message"]["content"]


def complete_json(prompt):
    text = chat([{"role": "user", "content": prompt}])
    match = re.search(r"\{.*\}", text, re.S)
    if not match:
        return None
    try:
        return json.loads(match.group(0))
    except ValueError:
        return None


def _class_noun(class_name):
    words = split_words(class_name)
    # UserServiceImpl -> User，UserRoleMapper -> User/Role，先剥掉分层后缀再找名词
    while len(words) > 1 and words[-1].lower() in CLASS_SUFFIXES:
        words.pop()
    for word in reversed(words):
        if word in NOUNS:
            return NOUNS[word]
    return ""


# 只在「同一层里不同类撞了同一个功能名」时用，把类名的限定词翻出来当前缀，
# 例如 CaptchaTokenGranter / PasswordTokenGranter 都叫「处理授权」时，
# 分别变成「验证码授权」「密码授权」。
MODIFIERS = {
    "captcha": "验证码", "password": "密码", "refresh": "刷新", "social": "社交",
    "sms": "短信", "email": "邮件", "mobile": "手机", "phone": "手机",
    "wechat": "微信", "weixin": "微信", "qq": "QQ", "weibo": "微博",
    "github": "GitHub", "gitee": "Gitee", "dingtalk": "钉钉", "ding": "钉钉",
    "jwt": "JWT", "oauth": "OAuth", "sso": "单点登录", "ldap": "LDAP",
    "sign": "签名", "encrypt": "加密", "decrypt": "解密", "secure": "安全",
    "lock": "锁定", "unlock": "解锁", "reset": "重置", "verify": "校验",
    "check": "校验", "valid": "校验", "limit": "限流", "flow": "流控",
    "gateway": "网关", "proxy": "代理", "remote": "远程", "feign": "远程",
    "admin": "管理端", "app": "移动端", "web": "网页端", "open": "开放",
    "tenant": "租户", "organization": "组织", "company": "公司", "dept": "部门",
    "role": "角色", "menu": "菜单", "dict": "字典", "param": "参数",
    "region": "区域", "post": "岗位", "notice": "通知", "log": "日志",
    "scope": "权限", "token": "令牌", "user": "用户", "client": "客户端",
    "order": "订单", "product": "商品", "cart": "购物车", "stock": "库存",
    "file": "文件", "oss": "对象存储", "minio": "对象存储", "qiniu": "对象存储",
    "cache": "缓存", "redis": "缓存", "id": "编号", "code": "编号",
    "error": "错误", "api": "接口", "usual": "常规", "common": "通用",
    "inner": "内部", "demo": "示例", "desk": "工作台", "develop": "开发",
    "system": "系统", "seata": "分布式事务", "blade": "平台",
    "data": "数据", "fallback": "降级", "sso": "单点登录",
}


def class_terms(class_name, limit=2):
    """类名里的限定词（中文化），用于区分同层同名的功能。"""
    words = split_words(class_name)
    popped = []
    while len(words) > 1 and words[-1].lower() in CLASS_SUFFIXES:
        word = words.pop()
        # 被剥掉的后缀里也有带含义的（ApiController 的 api），留着当限定词
        if word in MODIFIERS:
            popped.insert(0, word)
    terms = []
    for word in words + popped:
        term = MODIFIERS.get(word)
        if term and term not in terms:
            terms.append(term)
    return terms[-limit:]


def distinct_name(base, class_name):
    """把「处理授权」+ CaptchaTokenGranter 变成「验证码令牌授权」这类的具体名字。"""
    terms = class_terms(class_name)
    if not terms or not base:
        return ""
    verb = ""
    rest = base
    for candidate in sorted(set(VERBS.values()), key=len, reverse=True):
        if rest.startswith(candidate):
            verb, rest = candidate, rest[len(candidate):]
            break
    # 限定词与动作宾语重复时不重复拼接（LogApiController + 列出日志 → 列出接口日志）
    terms = [term for term in terms if term not in rest and term not in verb]
    if not terms:
        return ""
    return (verb + "".join(terms) + rest)[:16]


def guess_function_name(method_name, class_name=""):
    """updateStatus + OrderDao -> 更新订单状态。"""
    if method_name in SPECIAL:
        return SPECIAL[method_name]
    words = split_words(method_name)
    verb = ""
    rest = []
    for word in words:
        if not verb and word in VERBS:
            verb = VERBS[word]
            continue
        rest.append(word)
    tail = "".join(NOUNS.get(word, "") for word in rest)
    if not tail:
        tail = _class_noun(class_name)
    if not verb:
        verb = "处理"
    name = verb + tail
    return name[:16]


def guess_module_name(class_names, method_names):
    """从类名与方法名里挑出最有代表性的名词（类名权重更高）。"""
    weights = {}
    for class_name in class_names:
        for word in split_words(class_name):
            if word in NOUNS:
                weights[NOUNS[word]] = weights.get(NOUNS[word], 0) + 3
    for method_name in method_names:
        for word in split_words(method_name):
            if word in NOUNS:
                weights[NOUNS[word]] = weights.get(NOUNS[word], 0) + 1
    ranked = sorted(weights.items(), key=lambda item: (-item[1], item[0]))
    picked = [word for word, score in ranked
              if word not in MODULE_STOP and score >= 3][:2]
    if not picked:
        picked = [word for word, score in ranked if word not in MODULE_STOP][:1]
    if not picked:
        return "功能模块"
    return "".join(picked) + "管理"


def explain_method(method_name, doc=""):
    if doc:
        return doc
    return "处理%s相关逻辑" % guess_function_name(method_name)


def name_modules(entries):
    """entries: [{id, class_names, method_names}], 返回 {id: (名称, 依据)}。"""
    if available():
        payload = [{"id": item["id"], "classes": item["class_names"][:10],
                    "methods": item["method_names"][:12]} for item in entries]
        prompt = ("下面是从 Java 工程里抽取出的类与方法，每组属于同一功能模块。"
                  "请为每组给出 4-8 个汉字的功能名与一句话依据，输出 JSON："
                  '{"modules":[{"id":1,"name":"订单管理","evidence":"包含 OrderService 等类"}]}'
                  "\n\n" + json.dumps(payload, ensure_ascii=False))
        try:
            data = complete_json(prompt)
            if data and data.get("modules"):
                return {int(item["id"]): (item.get("name") or "", item.get("evidence") or "")
                        for item in data["modules"] if "id" in item}
        except (urllib.error.URLError, RuntimeError, ValueError, KeyError):
            pass
    result = {}
    for item in entries:
        name = guess_module_name(item["class_names"], item["method_names"])
        layers = item.get("layers") or []
        evidence = "包含 %d 个类、%d 个方法%s。" % (
            len(item["class_names"]), len(item["method_names"]),
            "，主要落在" + "、".join(layers) if layers else "")
        result[item["id"]] = (name, evidence)
    return result


def summarize_functions(entries):
    """entries: [{id, label, evidence}] -> {id: 说明}。"""
    if available():
        prompt = ("为下列代码功能条目各写一句 12-25 字的说明，说明它做什么、"
                  "返回什么；输出 JSON {\"items\":[{\"id\":1,\"summary\":\"...\"}]}\n\n"
                  + json.dumps(entries[:20], ensure_ascii=False))
        try:
            data = complete_json(prompt)
            if data and data.get("items"):
                return {int(item["id"]): item.get("summary") or ""
                        for item in data["items"] if "id" in item}
        except (urllib.error.URLError, RuntimeError, ValueError, KeyError):
            pass
    result = {}
    for item in entries:
        entry = item.get("entry") or ""
        return_type = item.get("return_type") or "void"
        if return_type in ("void", ""):
            result[item["id"]] = "入口 %s，无返回值。" % entry
        else:
            result[item["id"]] = "入口 %s，返回 %s。" % (entry, return_type)
    return result
