/**
 * ===========================================================
 * AC Master All-in-One (基于你上传的「新文件 13」逻辑重构)
 * ===========================================================
 *
 * ✅ 目的
 * ✅ 本版本（V12）你会看到的变化
 *  - 调度周期：10s（对应 Inject：周期触发 tick (10s)）
 *  - 相位延迟：stage1=2.0s / poll2=5.0s / stage2=8.2s（对应 3 个 Delay 节点）
 *  - 线条整理：3 个 Delay 回灌 Master 改为 Link in/out，画面更清爽
 *  - 机房散热扇：补齐“机房温度点位查询 + fan/light 两路控制”，避免出现一直不动

 *  - 用 1 个 Function 节点把：轮询查询 → 写入 flow → 控制计算 → 生成指令 → 发送指令 串起来
 *  - 保留「新文件 13」里的变量命名与核心控制逻辑（空调控制系统V4.1 + PTC联动控制系统）
 *
 * ✅ 本节点输出口（共 5 个）
 *  1) OUT1：HA 查询(current-state)   —— msg.payload = { entityId: "sensor.xxx" }
 *  2) OUT2：HA 执行(call-service)   —— msg.payload = { action, target, data }
 *  3) OUT3：面板TCP/串口指令Buffer   —— msg.payload = Buffer(...)
 *  4) OUT4：状态快照(WebSocket/Debug) —— msg.payload = object (可JSON.stringify)
 *  5) OUT5：内部调度(phase)         —— msg._phase = "stage1"|"poll2"|"stage2"
 *
 * ✅ 本节点输入消息类型（你不用手动构造，流里已经配好）
 *  - 周期触发：msg.payload === "tick"
 *  - 阶段触发：msg._event === "phase" && msg._phase in {"stage1","poll2","stage2"}
 *  - 查询回包：msg._event === "ha_state"（来自 api-current-state 输出）
 *  - 面板0x0C数据：msg._event === "panel_0x0c"（来自 link in 18，可选）
 *  - 清空：msg.payload === "reset"
 *
 * ⚠️ 你需要确认两件事
 *  1) link in 18 / link out 40 仍然接着你的“面板TCP收发”那套流（保持原ID可直接对上）
 *  2) Home Assistant 节点(server) 指向正确的 HA
 *
 * -----------------------------------------------------------
 * 调参建议（解决风速频繁跳变）
 *  - 重点在「空调控制系统V4.1」内部的 FAN_SPEED.stability 参数：
 *      min_duration_cycles / samples_required / force_reset_cycles
 *  - 先别乱改。等这版跑起来以后，再只动这 3 个参数。
 * -----------------------------------------------------------
  *
 * ============================================================
 * ✅ 关键枚举（本函数兼容的取值范围）
 * ============================================================
 * panel_mode（面板/用户选择的模式，flow: ${room}_panel_mode）：
 *   - "off","cool","heat","dry","fan","fan_only","auto","comfort"
 *   - 说明："fan" 会在算法里归一为 "fan_only"
 *
 * inner_mode（内机真实运行模式，flow: ${room}_inner_mode）：
 *   - "off","cool","heat","dry","fan_only","comfort"
 *
 * fan_mode（面板风速档，flow: ${room}_fan_mode）：
 *   - "low","medium","high","auto"
 * 同步到内机的风速（flow: ${room}_sync_fan）可能是：
 *   - "low","稍弱","medium","稍强","high","auto"
 *
 * ventilation_status（新风档位，flow: ventilation_status）：
 *   - "off","low","high"
 *
 * PTC状态（flow: ${room}_ptc_func_status / ${room}_ptc_hardware_status）：
 *   - 支持 boolean 或字符串："on"/"off"/"true"/"false"
 *
 * ============================================================
 * ✅ 你已确认的输入数据精度 / 分辨率（非常关键）
 * ============================================================
 * outdoor_fin_temp：1位小数（°C）
 * device_room_temp：1位小数（°C）
 * ${room}_return_temp：1位小数（°C）
 * ${room}_room_temp：大多整数；个别房间 1位小数（°C）
 * ${room}_target_temp：1°C 步进（整数）
 * system_power：实时功率（W）= 内机 + 外机 + 新风 + PTC（总功率）
 *
 * ============================================================
 * ✅ “远端持久化”策略（为了解决重启后的风速/补偿跳变）
 * ============================================================
 * 不持久化（每轮会刷新）：room_temp/return_temp/outdoor_fin_temp/system_power 等传感器输入
 * 会持久化（算法记忆）：风速防跳变计数/样本、温度补偿累计、喷淋计时、降频计数、风扇平滑计数等
 * 持久化通道：A机 -> WebSocket -> B机存储；A机可 recover 拉回 snapshot 并恢复到 flow
*/

/** =========================
 *  0) 工具函数
 *  ========================= */
function nowMs() { return Date.now(); }

function isNumber(x) { return typeof x === "number" && isFinite(x); }

function toNum(x) {
  const n = Number(x);
  return isFinite(n) ? n : null;
}

function round1(x) {
  const n = toNum(x);
  return n === null ? null : Math.round(n * 10) / 10;
}

function roundInt(x) {
  const n = toNum(x);
  return n === null ? null : Math.round(n);
}

function safeGet(obj, path, defVal) {
  try {
    const parts = String(path).split(".");
    let cur = obj;
    for (const p of parts) {
      if (cur == null) return defVal;
      cur = cur[p];
    }
    return cur === undefined ? defVal : cur;
  } catch (e) {
    return defVal;
  }
}

function deepClone(obj) {
  // 只用于小对象，避免复用 msg 引发串线
  return obj == null ? obj : JSON.parse(JSON.stringify(obj));
}

function makeQueryMsg(entityId, tag, extra = {}) {
  // =========================================================
  // 关键修复点（对应你看到的报错：Entity could not be found in cache）
  // ---------------------------------------------------------
  // file13 原版“动态查询” Function 会同时写：
  //   - msg.entityId = "climate.xxx"   （HomeAssistant current-state 节点优先读它）
  //   - msg.payload = { entityId: "climate.xxx" } （方便你在链路里保留元信息）
  //
  // 我之前的版本只写了 msg.payload.entityId，导致某些 HA 节点版本拿不到 entityId，
  // 最终去查 undefined / 空字符串，于是就会刷屏报错。
  // =========================================================
  const id = (entityId === null || entityId === undefined) ? "" : String(entityId);
  const cleanId = id.trim();

  const msg = {
    _event: "ha_query",
    _tag: tag || "",

    // ✅ file13 兼容：HA current-state 动态实体通常从 msg.entityId 取
    entityId: cleanId,

    // ✅ 兼容其他版本/调试：把 entityId 也塞进 payload 里
    payload: { entityId: cleanId },

    // ✅ 方便你在 Debug 里一眼看到查询的实体
    topic: cleanId
  };

  // 允许外部附加元信息（例如 room/what/phase 等）
  if (extra && typeof extra === "object") {
    for (const k of Object.keys(extra)) msg[k] = extra[k];
  }

  return msg;
}


function makeActionMsg(action, entityId, data, tag) {
  const msg = {
    _event: "ha_action",
    _tag: tag || "",
    payload: {
      action: String(action),
      target: { entity_id: [String(entityId)] },
      data: data ? deepClone(data) : {},
    },
  };
  return msg;
}

function makeTcpMsg(buffer, tag) {
  return {
    _event: "tcp_out",
    _tag: tag || "",
    payload: buffer,
  };
}

function makePhaseMsg(phase) {
  return {
    _event: "phase",
    _phase: phase,
    payload: phase,
  };
}

/** =========================
 *  1) 固定配置（尽量集中，方便你改）
 *  ========================= */
const CFG = {
  // —— 轮询与阶段 ——（和新文件13节奏一致）
  SCHEDULE: {
    // tick 后：立刻poll1（查询），3.1s 后 stage1（计算+发送），7.2s 后 poll2（再查一次），10.2s 后 stage2（PTC联动+发送）
    STAGE1_DELAY_S: 2.0,
    POLL2_DELAY_S: 5.0,
    STAGE2_DELAY_S: 8.2,
  },

  // —— Home Assistant 实体（来自 新文件13）——
  ENT: {
    outdoor_fin_temp: "sensor.wendu_3_1",
    system_power: "sensor.hvac_power_total",
    ventilation_fan: "fan.quan_wu_xin_feng",
    floor_heating: "climate.dinuangongshui",
    fan_power: "fan.yang_guang_fang_san_re",
    fan_speed_light: "light.she_bei_jian_san_re_feng_shan_diao_su_qi",

    // 设备房测温（用于 device_room_temp 加权平均）
    device_room_temp_point1: "sensor.wendu_4_1",
    device_room_temp_point2: "sensor.shi_wai_temperature",

    // 其它温度点（新文件13里有存，方便你看趋势）
    temp_1f_room: "sensor.can_ting_wen_du",
    temp_1f_return2: "sensor.can_ting_temperature",
    temp_2f_aisle_return2: "sensor.2lou_zhong_ting_temperature",
    temp_2f_aisle_return1: "climate.zhonghong_hvac_1_5",
  },

  // —— 房间映射：用于面板/面板风速(TCP)数据写入 flow 的变量前缀 —— 
// ✅ 这一段必须严格对齐「新文件13」：
//    这里的 key 不是随便编的，而是“面板协议里的 floor / room 编号”拼出来的 `${floor}_${room}`。
//    例如：客厅 = 1楼 1号房 -> key = "1_1"
//
// ⚠️ 注意：
//    - 这张表只覆盖“有面板数据/面板风速数据”的 8 个房间
//    - 厨房/卫生间虽然也有回风温度，但【没有】面板协议地址，所以不在这里
ROOM_BY_FLOORNO: {
  "1_1": "livingroom",
  "2_11": "bedroom1",
  "2_12": "bedroom2",
  "2_102": "bedroom3",
  "1_6": "studyroom",
  "1_3": "diningroom",
  "1_8": "bedroom1f",
  "2_25": "2faisle",
},

// —— 回风温度(zhonghong_hvac_x_y) 的“实体编号 -> roomName”映射 —— 
// ✅ file13 原本用 ENTITY_TO_ROOM 做映射；这里在大函数里也必须保持一致
//    key = `${group}_${index}`（对应 climate.zhonghong_hvac_<group>_<index>）
//    举例：climate.zhonghong_hvac_1_10 -> key = "1_10" -> bedroom2
ZH_HVAC_ROOM_BY_KEY: {
  "1_0": "kitchen",
  "1_1": "washroom",
  "1_2": "diningroom",
  "1_3": "studyroom",
  "1_4": "bedroom3",
  "1_5": "2faisle",
  "1_6": "livingroom",
  "1_8": "bedroom1f",
  "1_9": "bedroom1",
  "1_10": "bedroom2",
},

// —— 面板climate（用于读面板、写面板模式）——
// ✅ 必须与「新文件13」一致（ROOM_MAPPING / ROOM_TO_LOCATION）
PANEL_CLIMATES: [
  "climate.entity_mainlocal_243_204_1_1_4_3",   // livingroom
  "climate.entity_mainlocal_243_204_2_11_4_3",  // bedroom1
  "climate.entity_mainlocal_243_204_2_12_4_3",  // bedroom2
  "climate.entity_mainlocal_243_204_2_102_4_3", // bedroom3
  "climate.entity_mainlocal_243_204_1_6_4_3",   // studyroom
  "climate.entity_mainlocal_243_204_1_3_4_3",   // diningroom
  "climate.entity_mainlocal_243_204_1_8_4_3",   // bedroom1f
  "climate.entity_mainlocal_243_204_2_25_4_3",  // 2faisle
],

// —— 内机硬件climate（用于读回风温度、读内机模式）——
// ✅ 这里原来写成了 zhonghong_hvac_2_x，导致 HA 报 “Entity could not be found”
//    正确列表来自「新文件13」回风数据查询那一段：
//      1_0,1_1,1_2,1_3,1_4,1_5,1_6,1_8,1_9,1_10
INDOOR_STATUS_CLIMATES: [
  "climate.zhonghong_hvac_1_0",  // kitchen
  "climate.zhonghong_hvac_1_1",  // washroom
  "climate.zhonghong_hvac_1_2",  // diningroom
  "climate.zhonghong_hvac_1_3",  // studyroom
  "climate.zhonghong_hvac_1_4",  // bedroom3
  "climate.zhonghong_hvac_1_5",  // 2faisle
  "climate.zhonghong_hvac_1_6",  // livingroom
  "climate.zhonghong_hvac_1_8",  // bedroom1f
  "climate.zhonghong_hvac_1_9",  // bedroom1
  "climate.zhonghong_hvac_1_10", // bedroom2
],

// —— 发送内机控制用的“友好实体名”（来自 新文件13 生成内机应发数据）——
  INDOOR_CONTROL_ENTITY: {
    // ✅ “内机”对应的 HA climate 实体（用于下发 set_hvac_mode / set_temperature / set_fan_mode）
    // ✅ 同时也用于【查询】真实内机状态(state/hvac_action) —— 这是 file13 的关键逻辑
    diningroom: "climate.can_ting",
    kitchen: "climate.chu_fang",
    washroom: "climate.er_lou_da_wei_sheng_jian",
    bedroom2: "climate.er_lou_wo_shi_er",
    bedroom3: "climate.er_lou_wo_shi_san",
    bedroom1: "climate.er_lou_wo_shi_yi",
    "2faisle": "climate.er_lou_zhong_ting",
    livingroom: "climate.ke_ting",
    studyroom: "climate.shu_fang",
    bedroom1f: "climate.yi_lou_wo_shi"
  },



  // —— PTC 功能开关（来自 新文件13 生成PTC功能应发数据）——
  PTC_FUNC_ENTITY: {
    // ✅ PTC“功能开关”（你希望逻辑里开启/关闭的那个）
    //    注意：这是 file13 里原始使用的实体名（不是我猜的）
    diningroom: "switch.can_ting_dian_nuan_qi",
    bedroom1: "switch.wo_shi_1dian_nuan_qi",
    bedroom2: "switch.wo_shi_2dian_nuan_qi",
    bedroom3: "switch.wo_shi_3dian_nuan_qi",
    "2faisle": "switch.da_ting_dian_nuan_qi",
    livingroom: "switch.ke_ting_dian_nuan_qi",
    studyroom: "switch.shu_fang_dian_nuan_qi",
    bedroom1f: "switch.zhu_wo_dian_nuan_qi"
  },


  // —— PTC 硬件开关（出风口加热）（来自 新文件13 生成PTC硬件应发数据）——
  PTC_HW_ENTITY: {
    // ✅ PTC“硬件口加热”（出风口加热/电加热硬件开关）
    //    注意：这是 file13 里原始使用的实体名（不是我猜的）
    diningroom: "switch.can_ting_chu_feng_kou_jia_re",
    bedroom1: "switch.wo_shi_1chu_feng_kou_jia_re",
    bedroom2: "switch.wo_shi_2chu_feng_kou_jia_re",
    bedroom3: "switch.wo_shi_3chu_feng_kou_jia_re",
    "2faisle": "switch.da_ting_chu_feng_kou_jia_re",
    livingroom: "switch.ke_ting_chu_feng_kou_jia_re",
    studyroom: "switch.shu_fang_chu_feng_kou_jia_re",
    bedroom1f: "switch.zhu_wo_chu_feng_kou_jia_re"
  },


  // —— 水喷雾开关实体（来自 新文件13 操作喷水器）——
  WATER_SPRAY_ENTITY: "switch.zi_shui_qi",
};

/** =========================
 *  2) 写入 flow：HA 查询回包处理
 *  ========================= */
function writePanelClimateToFlow(entityId, entity) {
  // entityId：climate.entity_mainlocal_243_204_<floor>_<room>_4_3
  try {
    const pattern = /climate\.entity_mainlocal_243_204_(\d+)_(\d+)_4_3/;
    const m = String(entityId).match(pattern);
    if (!m) return false;

    const floor = m[1];
    const roomNumber = m[2];
    
const roomKey = `${floor}_${roomNumber}`;

// ✅ 回风温度的房间映射不等于“面板房间映射”
// - 面板用 ROOM_BY_FLOORNO（1_1 / 2_11 / 2_102 ...）
// - 回风温度用 ZH_HVAC_ROOM_BY_KEY（1_0 / 1_10 / 1_9 ...）
const roomName = CFG.ROOM_BY_FLOORNO[roomKey];
    if (!roomName) return false;

    const state = String(entity.state || "");
    const fanMode = entity.attributes && entity.attributes.fan_mode != null ? String(entity.attributes.fan_mode) : "";

    const currentTemp = toNum(safeGet(entity, "attributes.current_temperature", null));
    const targetTemp = toNum(safeGet(entity, "attributes.temperature", null));
    const hvacAction = safeGet(entity, "attributes.hvac_action", "");

    flow.set(`${roomName}_panel_mode`, state);
    flow.set(`${roomName}_fan_mode`, fanMode);
    flow.set(`${roomName}_hvac_action`, hvacAction);

    // room_temp：大部分取整，2faisle 保留 1 位（保持新文件13的规则）
    if (currentTemp != null) {
      if (roomName === "2faisle") flow.set(`${roomName}_room_temp`, round1(currentTemp));
      else flow.set(`${roomName}_room_temp`, parseInt(currentTemp, 10));
    }

    // target_temp：1度步进（取整）
    if (targetTemp != null) flow.set(`${roomName}_target_temp`, parseInt(targetTemp, 10));

    flow.set(`${roomName}_panel_updated`, new Date().toLocaleString());

    return true;
  } catch (err) {
    node.warn(`writePanelClimateToFlow error: ${err.message || err}`);
    return false;
  }
}

function writeIndoorClimateToFlow(entityId, entity) {
  // entityId：climate.zhonghong_hvac_<floor>_<room>
  try {
    const pattern = /climate\.zhonghong_hvac_(\d+)_(\d+)/;
    const m = String(entityId).match(pattern);
    if (!m) return false;

    const floor = m[1];
    const roomNumber = m[2];
    
const roomKey = `${floor}_${roomNumber}`;

// ✅ 回风温度的房间映射不等于“面板房间映射”
// - 面板用 ROOM_BY_FLOORNO（1_1 / 2_11 / 2_102 ...）
// - 回风温度用 ZH_HVAC_ROOM_BY_KEY（1_0 / 1_10 / 1_9 ...）
const roomName = CFG.ZH_HVAC_ROOM_BY_KEY[roomKey];
    if (!roomName) return false;

    // 回风温度：current_temperature（保留1位）
    const currentTemp = toNum(safeGet(entity, "attributes.current_temperature", null));
    if (currentTemp != null) flow.set(`${roomName}_return_temp`, round1(currentTemp));

    // 内机模式：entity.state
    const modeState = String(entity.state || "");
    flow.set(`${roomName}_inner_mode`, modeState);

    // 无面板主机：顺便保存目标温度（保持新文件13行为）
    if (roomName === "kitchen" || roomName === "washroom") {
      const targetTemp = toNum(safeGet(entity, "attributes.temperature", null));
      if (targetTemp != null) flow.set(`${roomName}_target_temp`, parseInt(targetTemp, 10));
    }

    return true;
  } catch (err) {
    node.warn(`writeIndoorClimateToFlow error: ${err.message || err}`);
    return false;
  }
}


function writeIndoorModeToFlow(entityId, entity) {
  // ✅ 对齐 file13「模式数据写入flow」：
  //    从“友好climate实体”（climate.ke_ting / climate.can_ting ...）写入：
  //      - ${room}_inner_mode
  //      - ${room}_hvac_action
  try {
    const roomName = Object.keys(CFG.INDOOR_CONTROL_ENTITY).find(r => CFG.INDOOR_CONTROL_ENTITY[r] === entityId);
    if (!roomName) return false;

    const state = String(entity.state || "");
    const hvacAction = safeGet(entity, "attributes.hvac_action", "");

    flow.set(`${roomName}_inner_mode`, state);
    flow.set(`${roomName}_hvac_action`, hvacAction);

    // 额外：保存一次更新时间，便于你排查“状态不刷”的问题
    flow.set(`${roomName}_inner_updated`, new Date().toLocaleString());

    return true;
  } catch (err) {
    node.warn(`writeIndoorModeToFlow error: ${err.message || err}`);
    return false;
  }
}

function writePTCFuncToFlow(entityId, entity) {
  // switch.<room>_dian_nuan_qi
  try {
    // 反向查 roomName
    const roomName = Object.keys(CFG.PTC_FUNC_ENTITY).find(r => CFG.PTC_FUNC_ENTITY[r] === entityId);
    if (!roomName) return false;

    const state = String(entity.state || "").toLowerCase();
    flow.set(`${roomName}_ptc_func_status`, state === "on");
    return true;
  } catch (err) {
    node.warn(`writePTCFuncToFlow error: ${err.message || err}`);
    return false;
  }
}

function writePTCHwToFlow(entityId, entity) {
  // switch.<room>_chu_feng_kou_jia_re
  try {
    const roomName = Object.keys(CFG.PTC_HW_ENTITY).find(r => CFG.PTC_HW_ENTITY[r] === entityId);
    if (!roomName) return false;

    const state = String(entity.state || "").toLowerCase();
    flow.set(`${roomName}_ptc_hardware_status`, state === "on");
    return true;
  } catch (err) {
    node.warn(`writePTCHwToFlow error: ${err.message || err}`);
    return false;
  }
}

function writeMiscEntitiesToFlow(entityId, entity) {
  try {
    const stateStr = String(entity.state ?? "");
    if (entityId === CFG.ENT.outdoor_fin_temp) {
      const n = round1(stateStr);
      if (n != null) flow.set("outdoor_fin_temp", n);
      return true;
    }

    if (entityId === CFG.ENT.system_power) {
      const n = toNum(stateStr);
      if (n != null) flow.set("system_power", n);
      return true;
    }

        if (entityId === CFG.ENT.ventilation_fan) {
      // ✅ 对齐 file13「新风状态写入flow」
      // ventilation_status: off/low/high（基于 percentage）
      const st = String(entity.state ?? "").toLowerCase();
      const perc = toNum(safeGet(entity, "attributes.percentage", null));
      const preset = safeGet(entity, "attributes.preset_mode", null);
      if (preset != null) flow.set("ventilation_preset_mode", String(preset));

      if (st === "off") {
        flow.set("ventilation_status", "off");
      } else if (perc != null) {
        if (perc >= 80) flow.set("ventilation_status", "high");
        else if (perc > 0) flow.set("ventilation_status", "low");
        else flow.set("ventilation_status", "off");
      } else {
        // 没有 percentage 时，兜底：on -> low
        flow.set("ventilation_status", st === "on" ? "low" : st);
      }
      return true;
    }

    if (entityId === CFG.ENT.floor_heating) {
      // climate 的 state 通常是 hvac_mode，例如 "heat"/"off"
      flow.set("floor_heating_on", stateStr === "heat");
      return true;
    }

    if (entityId === CFG.ENT.fan_power) {
      // fan 的 state 通常是 "on"/"off"
      flow.set("fan_power_switch", stateStr === "on");
      return true;
    }

    if (entityId === CFG.ENT.fan_speed_light) {
      // light 的亮度属性 brightness (0-255)
      const b = toNum(safeGet(entity, "attributes.brightness", null));
      if (b != null) flow.set("fan_speed", b);
      return true;
    }

    if (entityId === CFG.WATER_SPRAY_ENTITY) {
      // switch.pen_wu
      const st = String(entity.state ?? "").toLowerCase();
      flow.set("water_spray_status", st);
      return true;
    }


    // device room temp points
    if (entityId === CFG.ENT.device_room_temp_point1) {
      const n = round1(stateStr);
      if (n != null) flow.set("device_room_temp_point1", n);
      return true;
    }
    if (entityId === CFG.ENT.device_room_temp_point2) {
      const n = round1(stateStr);
      if (n != null) flow.set("device_room_temp_point2", n);
      return true;
    }

    // 其它温度点：保留（方便你在 HA 看趋势）
    if (entityId === CFG.ENT.temp_1f_room) {
      const n = round1(stateStr);
      if (n != null) {
        // 新文件13里同一个实体被用作两个参考点，这里直接都写上，等你以后换成两个实体也不用改逻辑
        flow.set("1faislebacktemp1", n);
        flow.set("1faislebacktemp2", n);
      }
      return true;
    }

    if (entityId === CFG.ENT.temp_1f_return2) {
      const n = round1(stateStr);
      if (n != null) flow.set("1faislebacktemp2", n);
      return true;
    }

    if (entityId === CFG.ENT.temp_2f_aisle_return2) {
      const n = round1(stateStr);
      if (n != null) flow.set("2faislebacktemp2", n);
      return true;
    }

    if (entityId === CFG.ENT.temp_2f_aisle_return1) {
      // 这是 climate，回风温度在 attributes.current_temperature
      const n = round1(safeGet(entity, "attributes.current_temperature", null));
      if (n != null) flow.set("2faislebacktemp1", n);
      return true;
    }


    // 喷水器开关状态（file13 实体：switch.zi_shui_qi）
    // - state: "on"/"off"
    // - 记录到 flow.water_spray_switch，供“去重+安全输出”判断
    if (entityId === CFG.WATER_SPRAY_ENTITY) {
      flow.set("water_spray_switch", stateStr === "on");
      return true;
    }

    return false;
  } catch (err) {
    node.warn(`writeMiscEntitiesToFlow error: ${err.message || err}`);
    return false;
  }
}

function handleHaStateResponse(msg) {
  // api-current-state 输出：msg.data 是完整 entity 对象
  const entity = msg.data || {};
  const entityId = String(entity.entity_id || safeGet(msg, "payload.entity_id", "") || "");

  if (!entityId) return;

  // 1) 面板 climate
  if (entityId.startsWith("climate.entity_mainlocal_243_204_")) {
    writePanelClimateToFlow(entityId, entity);
    return;
  }


  // 1.5) 友好climate（真实内机模式/动作）—— 对齐 file13
  if (writeIndoorModeToFlow(entityId, entity)) {
    return;
  }

  // 2) 内机硬件 climate
  if (entityId.startsWith("climate.zhonghong_hvac_")) {
    writeIndoorClimateToFlow(entityId, entity);
    // 同时：餐厅回风口温度1/二楼中厅回风口温度1等属于 climate，已在 writeMiscEntitiesToFlow 里按实体ID单独处理
    writeMiscEntitiesToFlow(entityId, entity);
    return;
  }

  // 3) PTC
  if (entityId.startsWith("switch.")) {
    if (writePTCFuncToFlow(entityId, entity)) return;
    if (writePTCHwToFlow(entityId, entity)) return;
  }

  // 4) 其它
  writeMiscEntitiesToFlow(entityId, entity);
}

/** =========================
 *  3) 面板0x0C数据：解析风速并写入 flow
 *  ========================= */
function handlePanel0x0cPayload(raw) {
  // raw 可以是 Buffer / Uint8Array / 数组
  let buf = null;
  if (Buffer.isBuffer(raw)) buf = raw;
  else if (raw instanceof Uint8Array) buf = Buffer.from(raw);
  else if (Array.isArray(raw)) buf = Buffer.from(raw);
  else return;

  // 新文件13「处理0xc」：每8字节一个片段，首字节必须是 0x0C
  const slices = [];
  for (let i = 0; i + 8 <= buf.length; i += 8) {
    const piece = buf.slice(i, i + 8);
    if (piece[0] === 0x0c) slices.push(piece);
  }
  if (!slices.length) return;

  // 新文件13「面板【风速】」：data[2] floor, data[3] room, data[4] speed标识
  for (const piece of slices) {
    const data = Array.from(piece);
    const floor = data[2];
    const roomNo = data[3];
    const roomKey = `${floor}_${roomNo}`;
    const roomName = CFG.ROOM_BY_FLOORNO[roomKey];
    if (!roomName) continue;

    let fanmode = "high";
    if (data[4] === 0x0a) fanmode = "low";
    else if (data[4] === 0x14) fanmode = "medium";

    flow.set(`${roomName}_fan_mode`, fanmode);
    flow.set(`${roomName}_panel_fan_updated`, new Date().toLocaleString());
  }
}

/** =========================
 *  4) 设备房温度加权平均（新文件13：device_room_temp）
 *  ========================= */
function computeDeviceRoomTemp() {
  const t1 = toNum(flow.get("device_room_temp_point1"));
  const t2 = toNum(flow.get("device_room_temp_point2"));

  // ✅ 容错：任意一个点位缺失时，退化为“用另一个点位”
  // 这样设备房温度不会一直 undefined，算法也更稳定
  if (t1 == null && t2 == null) return;

  if (t1 != null && t2 == null) {
    flow.set("device_room_temp", round1(t1));
    return;
  }
  if (t1 == null && t2 != null) {
    flow.set("device_room_temp", round1(t2));
    return;
  }

  // 新文件13：point1 权重 1.5，point2 权重 1.0
  const w1 = 1.5;
  const w2 = 1.0;
  const avg = (t1 * w1 + t2 * w2) / (w1 + w2);

  flow.set("device_room_temp", round1(avg));
}

/** =========================
 *  5) 主控制算法（直接内嵌「空调控制系统V4.1」原代码）
 *  ========================= */
function runMainControlV41() {

  /****************************************************************************
   * 空调控制系统完整方案 v4.1
   * 修复：喷水器时间控制、温度判断优化、所有时间相关功能
   * 新增：node.status状态显示
   ****************************************************************************/

  /************* 系统基础配置 *************/
  const SYSTEM = {
      // 执行周期（毫秒）- 控制系统每隔多久运行一次
      execution_period_ms: 10000,  // 10秒
      // 总体控制开关
      active: true,  // 系统是否激活，设为false可临时停用所有控制
      // 调试配置
      debug: {
          enabled: false,            // 是否输出调试信息
          level: 1,                 // 调试等级：1=基本信息，2=详细信息，3=全部信息
          max_length: 400,          // 单条日志最大长度（超过会分段显示）
          ptc_debug: true           // PTC专用调试（独立开关，不受level影响）
      },
      // 功能开关
      features: {
          temp_compensation: true,  // 温度补偿功能
          auto_fan_control: true,   // 自动风速控制
          device_room_fan: true,    // 设备房风扇控制
          water_spray_control: true, // 喷水器控制
          new_ventilation: true     // 新风控制功能
      }
  };

  /************* 内机配置 *************/
  // 所有内机参数集中配置，便于管理和修改
  const INDOOR_UNITS = {
      // 主要生活区域
      "bedroom1": {
          capacity: 1.8,           // 内机匹数
          has_external_panel: true, // 是否有外置面板
          fan_power: 50,           // 内机风机额定功率(W)
          ptc_enabled: true,       // 是否支持PTC电制热
          temp_weight: 1          // 室温计算权重
      },
      "bedroom2": {
          capacity: 1.8,
          has_external_panel: true,
          fan_power: 50,
          ptc_enabled: true,
          temp_weight: 1
      },
      "bedroom3": {
          capacity: 1.6,
          has_external_panel: true,
          fan_power: 50,
          ptc_enabled: false,
          temp_weight: 1
      },
      "bedroom1f": {
          capacity: 1.3,
          has_external_panel: true,
          fan_power: 50,
          ptc_enabled: true,
          temp_weight: 0.9
      },
      "livingroom": {
          capacity: 3.0,
          has_external_panel: true,
          fan_power: 60,
          ptc_enabled: true,
          temp_weight: 1.2
      },
      "studyroom": {
          capacity: 1,
          has_external_panel: true,
          fan_power: 50,
          ptc_enabled: false,
          temp_weight: 0.9
      },
      "2faisle": {
          capacity: 0.8,
          has_external_panel: true,
          fan_power: 50,
          ptc_enabled: false,
          temp_weight: 0.7
      },
      "diningroom": {
          capacity: 2.5,
          has_external_panel: true,
          fan_power: 50,
          ptc_enabled: false,
          temp_weight: 0.7
      },
      // 辅助区域（仅监控）
      "kitchen": {
          capacity: 0.8,
          has_external_panel: false,
          fan_power: 40,
          ptc_enabled: false,
          temp_weight: 0.5
      },
      "washroom": {
          capacity: 0.8,
          has_external_panel: false,
          fan_power: 40,
          ptc_enabled: false,
          temp_weight: 0.5
      }
  };

  /************* PTC电制热配置 *************/
  const PTC = {
      // 基础参数
      power: 1500,          // PTC功率(W)
      retry_max: 2,         // 最大尝试轮次
      // 安全参数
      max_temp: 30,         // 最高环境温度(°C)
      min_temp: 5,          // 最低环境温度(°C)
      // 全局开关
      global_enabled: true  // 全局开关
  };

  /************* 喷水器配置 *************/
  const WATER_SPRAY = {
      // 执行次数控制参数（基于10秒执行周期）
      min_duration_cycles: 20,    // 最短喷水持续周期数 - 150秒
      max_duration_cycles: 80,    // 最长喷水持续周期数 - 1200秒
      min_interval_cycles: 40,    // 最小喷水间隔周期数 - 600秒
      // 温度阈值
      trigger_temp: 43.0,         // 触发温度(°C)
      stop_temp: 38.0,           // 停止温度(°C) - 增大滞回区间防止频繁开关
      // 智能判断参数
      temp_drop_threshold: 3.0,   // 温度下降阈值 - 温度下降超过此值才考虑停止
      recovery_temp: 40.0         // 恢复判断温度 - 用于判断是否需要继续喷水
  };

  /************* 设备房风扇控制 *************/
  const FAN = {
      // 风扇物理参数
      min_output: 140,        // 最小输出值(0-255)
      start_delay_cycles: 1,  // 启动延迟(周期数)
      // 平滑控制参数
      speed_step: 5,          // 转速调整步长(0-255)
      interval_cycles: 1,     // 调速间隔(周期数)
      // 夏季制冷散热参数
      cooling: {
          start_temp: 35.0,   // 起转温度(°C)
          max_temp: 43.0,     // 最大温度(°C)
      },
      // 冬季制热辅助参数
      heating: {
          start_temp: 10.0,   // 起转温度(°C)
          min_temp: -5.0,     // 最低温度(°C)
      },
      // 设备房温控参数
      room: {
          start_temp: 30.0,   // 起转温度(°C)
          max_temp: 40.0      // 最大温度(°C)
      }
  };

  /************* 新风控制参数 *************/
  const VENTILATION = {
      // 控制模式
      modes: {
          bypass: "bypass",       // 旁通模式
          heat_exchange: "heat"   // 热交换模式
      },
      // 控制参数
      temp_diff_threshold: 2.0,   // 温差阈值(°C)
      comfort_temp: 24.0          // 舒适温度(°C)
  };

  /************* 温度补偿参数 *************/
  const TEMP_COMPENSATION = {
      // 基础补偿参数
      cooling: {
          max_negative: -2.0,     // 最大负补偿(°C)
          factor: 0.5             // 补偿系数
      },
      heating: {
          min_positive: 1.0,      // 最小正补偿(°C)
          factor: 1.0             // 补偿系数
      },
      // 累计补偿参数
      accumulated: {
          step: 0.1,              // 每次补偿步长(°C)
          max: 1.5,               // 最大累计补偿(°C)
          reset_cycles: 12        // 补偿重置周期数
      },
      // 惩罚机制参数
      penalty: {
          threshold: 0.6,         // 惩罚阈值(°C)
          cycles: 4,              // 触发周期数
          factor: 0.5             // 惩罚系数
      },
      // 精度处理
      precision: 0.5              // 设定温度精度(°C)
  };

  /************* 风速控制参数 *************/
  const FAN_SPEED = {
      // 风速档位
      panel_levels: ["low", "medium", "high", "auto"],
      indoor_levels: ["low", "稍弱", "medium", "稍强", "high", "auto"],
      // 风速档位索引
      level_indexes: {
          "low": 0,
          "稍弱": 1,
          "medium": 2,
          "稍强": 3,
          "high": 4,
          "auto": 5
      },
      // 面板风速到内机风速的映射
      panel_to_indoor: {
          "low": "low",
          "medium": "medium",
          "high": "high",
          "auto": "auto"
      },
      // 温差风速自动控制映射表
      auto_control: [
          { diff: 0.5, speed: "low" },
          { diff: 0.7, speed: "稍弱" },
          { diff: 1.0, speed: "medium" },
          { diff: 1.5, speed: "稍强" },
          { diff: 999, speed: "high" }
      ],
      // 风速累计调整参数
      accumulation: {
          threshold: 0.3,
          max_value: 1.0,
          step: 0.1,
          reset_cycles: 8
      },
      // 风速防跳变参数
      stability: {
          min_duration_cycles: 5,
          samples_required: 4,
          force_reset_cycles: 13
      }
  };

  /************* 功率计算参数 *************/
  const POWER = {
      // 基础功率参数
      base: 180.0,               // 系统基础功率(W)
      per_unit: 700.0,           // 每匹基础功率(W)
      rated_capacity: 12.0,      // 外机额定匹数
      // 功率调整系数
      temp_diff_coef: 0.1,       // 温差影响系数
      // 模式功率系数
      mode_factors: {
          cool: 1.0,
          heat: 1.0,
          dry: 0.4,
          comfort: 0.8,
          fan_only: 0.0
      },
      // 降频检测参数
      derating: {
          threshold: 0.8,
          count_required: 3,
          check_interval: 1
      }
  };

  /***** 安全数字格式化函数 *****/
  function safeToFixed(value, digits = 1) {
      try {
          const numValue = Number(value);
          if (!isNaN(numValue)) {
              return numValue.toFixed(digits);
          }
          return "0.0";
      } catch (e) {
          return "0.0";
      }
  }

  /***** PTC状态转换函数 *****/
  function ptcStatusToBool(status) {
      if (typeof status === "boolean") return status;
      if (status === "on" || status === "true") return true;
      return false;
  }

  /***** PTC专用调试函数 *****/
  function ptcDebug(room_id, message) {
      if (SYSTEM.debug.enabled && SYSTEM.debug.ptc_debug) {
          node.warn(`[PTC调试][${room_id}] ${message}`);
      }
  }

  /***** 调试函数 *****/
  function debug(level, section, message) {
      if (SYSTEM.debug.enabled && level <= SYSTEM.debug.level) {
          const prefix = `[${section}] `;
          const full_message = prefix + message;
          if (full_message.length > SYSTEM.debug.max_length) {
              const parts = [];
              for (let i = 0; i < full_message.length; i += SYSTEM.debug.max_length) {
                  parts.push(full_message.substring(i, i + SYSTEM.debug.max_length));
              }
              parts.forEach((part, index) => {
                  node.warn(`${part} (${index + 1}/${parts.length})`);
              });
          } else {
              node.warn(full_message);
          }
      }
  }

  /***** 确定外机工作状态 *****/
    /***** 确定外机工作状态 *****/
  function determineOutdoorStatus() {
      // ✅ 对齐 file13：外机状态只看“真实内机模式(inner_mode)”
      //  - heat          -> 外机制热
      //  - cool/dry/comfort -> 外机制冷
      //  - off/fan_only  -> 不算外机工作
      let anyRoomHeating = false;
      let anyRoomCooling = false;

      for (const room_id in INDOOR_UNITS) {
          const mode = flow.get(`${room_id}_inner_mode`) || "off";
          if (mode === "heat") {
              anyRoomHeating = true;
          } else if (["cool", "dry", "comfort"].includes(mode)) {
              anyRoomCooling = true;
          }
      }

      if (anyRoomHeating) {
          return "heat";
      } else if (anyRoomCooling) {
          return "cool";
      } else {
          return "off";
      }
  }

  /***** 获取活跃内机数量 *****/
  function getActiveIndoorUnits() {
      let activeCount = 0;
      let heatingCount = 0;
      let coolingCount = 0;
      const activeRooms = [];

      for (const room_id in INDOOR_UNITS) {
          const mode = flow.get(`${room_id}_inner_mode`) || "off";
          if (mode !== "off" && mode !== "fan_only") {
              activeCount++;
              activeRooms.push(room_id);
              if (mode === "heat") {
                  heatingCount++;
              } else if (["cool", "dry", "comfort"].includes(mode)) {
                  coolingCount++;
              }
          }
      }

      return {
          count: activeCount,
          heatingCount,
          coolingCount,
          rooms: activeRooms
      };
  }

function calculateAverageRoomTemp() {
      let totalWeight = 0;
      let weightedTempSum = 0;
      let validRooms = 0;

      for (const room_id in INDOOR_UNITS) {
          const unit = INDOOR_UNITS[room_id];
          let room_temp;
          if (unit.has_external_panel) {
              room_temp = flow.get(`${room_id}_room_temp`);
          } else {
              room_temp = flow.get(`${room_id}_return_temp`);
          }

          if (room_temp !== undefined && room_temp !== null) {
              const weight = unit.temp_weight || 1.0;
              weightedTempSum += Number(room_temp) * weight;
              totalWeight += weight;
              validRooms++;
          }
      }

      if (validRooms > 0) {
          return weightedTempSum / totalWeight;
      } else {
          return null;
      }
  }

  /***** 确定新风运行模式 *****/
  function determineVentilationMode() {
      if (!SYSTEM.features.new_ventilation) {
          return null;
      }

      const ventilation_status = flow.get('ventilation_status') || "off";
      if (ventilation_status === "off") {
          return null;
      }

      const device_room_temp = Number(flow.get('device_room_temp') || 25.0);
      const avg_room_temp = calculateAverageRoomTemp() || VENTILATION.comfort_temp;
      const floor_heating_on = flow.get('floor_heating_on') || false;
      const outdoor_status = determineOutdoorStatus();

      const temp_diff = device_room_temp - avg_room_temp;
      debug(2, "新风控制", `设备房温度: ${safeToFixed(device_room_temp)}℃, 室内平均温度: ${safeToFixed(avg_room_temp)}℃, 温差: ${safeToFixed(temp_diff)}℃`);

      if (outdoor_status === "cool") {
          if (temp_diff < -VENTILATION.temp_diff_threshold) {
              debug(1, "新风控制", `制冷模式 + 设备房较凉爽(${safeToFixed(temp_diff)}℃)，切换为旁通模式`);
              return VENTILATION.modes.bypass;
          }
      }
      else if (outdoor_status === "heat" || floor_heating_on) {
          if (temp_diff > VENTILATION.temp_diff_threshold) {
              debug(1, "新风控制", `制热模式 + 设备房较温暖(${safeToFixed(temp_diff)}℃)，切换为旁通模式`);
              return VENTILATION.modes.bypass;
          }
      }
      else if (outdoor_status === "off" && !floor_heating_on) {
          if (Math.abs(avg_room_temp - VENTILATION.comfort_temp) > VENTILATION.temp_diff_threshold) {
              if (Math.abs(device_room_temp - VENTILATION.comfort_temp) < Math.abs(avg_room_temp - VENTILATION.comfort_temp)) {
                  debug(1, "新风控制", `设备关闭 + 设备房温度更舒适(${safeToFixed(device_room_temp)}℃)，切换为旁通模式`);
                  return VENTILATION.modes.bypass;
              }
          }
      }

      debug(2, "新风控制", `默认使用热交换模式（节能）`);
      return VENTILATION.modes.heat_exchange;
  }

  /***** 风扇转速平滑调整 *****/
  function smoothFanSpeedAdjustment(current_speed, target_speed, fan_state) {
      if (target_speed === current_speed) {
          return current_speed;
      }

      // 使用状态对象管理计数器
      const state = fan_state || {};
      const adjustment_counter = state.adjustment_counter || 0;

      if (adjustment_counter < FAN.interval_cycles) {
          state.adjustment_counter = adjustment_counter + 1;
          return current_speed;
      }

      state.adjustment_counter = 0;

      let new_speed;
      if (target_speed > current_speed) {
          new_speed = Math.min(current_speed + FAN.speed_step, target_speed);
      } else {
          new_speed = Math.max(current_speed - FAN.speed_step, target_speed);
      }

      if (new_speed > 0 && new_speed < FAN.min_output) {
          new_speed = FAN.min_output;
      }

      debug(2, "风扇控制", `风扇速度平滑调整: ${current_speed} → ${new_speed} (目标: ${target_speed})`);
      return new_speed;
  }

  /***** 获取对应温差的风速档位 *****/
  function getFanSpeedForTempDiff(room_id, temp_diff, is_heating) {
      const accum_diff = flow.get(`${room_id}_accum_temp_diff`) || 0;
      const current_fan_speed = flow.get(`${room_id}_current_fan_speed`) || "low";
      const fan_change_counter = flow.get(`${room_id}_fan_change_counter`) || 0;
      const fan_samples = flow.get(`${room_id}_fan_samples`) || [];
      const opposite_diff_counter = flow.get(`${room_id}_opposite_diff_counter`) || 0;
      const force_reset_counter = flow.get(`${room_id}_force_reset_counter`) || 0;

      const adjusted_diff = is_heating ? temp_diff : -temp_diff;

      let new_force_reset_counter = force_reset_counter + 1;
      if (new_force_reset_counter >= FAN_SPEED.stability.force_reset_cycles) {
          debug(1, room_id, `[风速控制] 强制重置风速状态 - 连续${new_force_reset_counter}个周期没有变化`);
          flow.set(`${room_id}_accum_temp_diff`, 0);
          flow.set(`${room_id}_fan_samples`, []);
          flow.set(`${room_id}_fan_change_counter`, 0);
          flow.set(`${room_id}_opposite_diff_counter`, 0);
          flow.set(`${room_id}_force_reset_counter`, 0);

          if (Math.abs(adjusted_diff) < 0.3) {
              return "low";
          } else if (Math.abs(adjusted_diff) > 1.5) {
              return "high";
          }
      } else {
          flow.set(`${room_id}_force_reset_counter`, new_force_reset_counter);
      }

      let new_opposite_diff_counter = opposite_diff_counter;
      if ((adjusted_diff > 0 && accum_diff < 0) || (adjusted_diff < 0 && accum_diff > 0)) {
          new_opposite_diff_counter++;
          if (new_opposite_diff_counter >= FAN_SPEED.accumulation.reset_cycles) {
              debug(1, room_id, `[风速控制] 重置累计温差 - 连续${new_opposite_diff_counter}个周期温差方向相反`);
              flow.set(`${room_id}_accum_temp_diff`, 0);
              new_opposite_diff_counter = 0;
          }
      } else {
          new_opposite_diff_counter = 0;
      }
      flow.set(`${room_id}_opposite_diff_counter`, new_opposite_diff_counter);

      let new_accum_diff = accum_diff;
      if (adjusted_diff > 0) {
          new_accum_diff += FAN_SPEED.accumulation.step;
      } else if (adjusted_diff < 0) {
          new_accum_diff -= FAN_SPEED.accumulation.step;
      }

      new_accum_diff = Math.max(-FAN_SPEED.accumulation.max_value,
          Math.min(FAN_SPEED.accumulation.max_value, new_accum_diff));

      flow.set(`${room_id}_accum_temp_diff`, new_accum_diff);

      let ideal_speed;
      if (adjusted_diff <= 0 && new_accum_diff < FAN_SPEED.accumulation.threshold) {
          ideal_speed = "low";
      } else {
          const effective_diff = Math.max(adjusted_diff, new_accum_diff);
          for (const mapping of FAN_SPEED.auto_control) {
              if (effective_diff <= mapping.diff) {
                  ideal_speed = mapping.speed;
                  break;
              }
          }
          if (!ideal_speed) ideal_speed = "稍弱";
      }

      let target_speed = ideal_speed;
      if (ideal_speed !== current_fan_speed) {
          const current_index = FAN_SPEED.level_indexes[current_fan_speed] || 0;
          const ideal_index = FAN_SPEED.level_indexes[ideal_speed] || 0;

          const step_direction = ideal_index > current_index ? 1 : -1;
          const new_index = current_index + step_direction;

          if (new_index >= 0 && new_index <= 4) {
              for (const [level, index] of Object.entries(FAN_SPEED.level_indexes)) {
                  if (index === new_index) {
                      target_speed = level;
                      break;
                  }
              }
          }

          debug(2, room_id, `[风速阶梯] 理想风速=${ideal_speed}(${ideal_index}), 当前风速=${current_fan_speed}(${current_index}), 目标风速=${target_speed}(${new_index})`);
      }

      fan_samples.push(target_speed);
      if (fan_samples.length > FAN_SPEED.stability.samples_required) {
          fan_samples.shift();
      }
      flow.set(`${room_id}_fan_samples`, fan_samples);

      const all_same = fan_samples.length === FAN_SPEED.stability.samples_required &&
          fan_samples.every(s => s === fan_samples[0]);

      let new_fan_change_counter = fan_change_counter;
      if (current_fan_speed !== target_speed) {
          new_fan_change_counter++;
      } else {
          new_fan_change_counter = 0;
      }
      flow.set(`${room_id}_fan_change_counter`, new_fan_change_counter);

      const can_change_speed = (new_fan_change_counter >= FAN_SPEED.stability.min_duration_cycles) && all_same;

      let final_speed;
      if (can_change_speed) {
          final_speed = fan_samples[0];
          flow.set(`${room_id}_fan_change_counter`, 0);
          flow.set(`${room_id}_force_reset_counter`, 0);
          if (final_speed !== current_fan_speed) {
              flow.set(`${room_id}_current_fan_speed`, final_speed);
              debug(1, room_id, `[风速控制] 风速变化: ${current_fan_speed} → ${final_speed}, 累计温差: ${safeToFixed(new_accum_diff, 2)}, 实际温差: ${safeToFixed(adjusted_diff, 2)}`);
          }
      } else {
          final_speed = current_fan_speed;
          debug(2, room_id, `[风速控制] 保持风速: ${final_speed}, 目标风速: ${target_speed}, 累计温差: ${safeToFixed(new_accum_diff, 2)}, 样本数: ${fan_samples.length}, 计数: ${new_fan_change_counter}`);
      }

      return final_speed;
  }

  /***** 风扇转速计算函数 *****/
  function calculateFanSpeed(outdoor_fin_temp, outdoor_status, device_room_temp) {
      let target_speed = 0;

      if (!SYSTEM.features.device_room_fan) {
          return 0;
      }

      if (outdoor_status === "cool") {
          if (outdoor_fin_temp < FAN.cooling.start_temp) {
              target_speed = 0;
          } else if (outdoor_fin_temp >= FAN.cooling.max_temp) {
              target_speed = 255;
          } else {
              const temp_range = FAN.cooling.max_temp - FAN.cooling.start_temp;
              const ratio = (outdoor_fin_temp - FAN.cooling.start_temp) / temp_range;
              target_speed = FAN.min_output + Math.floor((255 - FAN.min_output) * ratio);
              target_speed = Math.max(FAN.min_output, Math.min(255, target_speed));
          }
          debug(2, "风扇控制", `制冷模式: 翅片温度=${safeToFixed(outdoor_fin_temp)}℃, 目标风扇速度=${target_speed}`);
      }
      else if (outdoor_status === "heat") {
          if (outdoor_fin_temp <= FAN.heating.start_temp) {
              if (outdoor_fin_temp <= FAN.heating.min_temp) {
                  target_speed = 255;
              } else {
                  const temp_range = FAN.heating.start_temp - FAN.heating.min_temp;
                  const ratio = (FAN.heating.start_temp - outdoor_fin_temp) / temp_range;
                  target_speed = FAN.min_output + Math.floor((255 - FAN.min_output) * ratio);
                  target_speed = Math.max(FAN.min_output, Math.min(255, target_speed));
              }
              debug(2, "风扇控制", `制热模式: 翅片温度=${safeToFixed(outdoor_fin_temp)}℃, 目标风扇速度=${target_speed}`);
          }
      }

      if (device_room_temp >= FAN.room.start_temp) {
          let room_fan_speed = 0;
          if (device_room_temp >= FAN.room.max_temp) {
              room_fan_speed = 255;
          } else {
              const temp_range = FAN.room.max_temp - FAN.room.start_temp;
              const ratio = (device_room_temp - FAN.room.start_temp) / temp_range;
              room_fan_speed = FAN.min_output + Math.floor((255 - FAN.min_output) * ratio);
              room_fan_speed = Math.max(FAN.min_output, Math.min(255, room_fan_speed));
          }
          debug(2, "风扇控制", `设备房温度=${safeToFixed(device_room_temp)}℃, 目标散热风扇速度=${room_fan_speed}`);
          target_speed = Math.max(target_speed, room_fan_speed);
      }

      return target_speed;
  }

  /***** 改进的喷水器控制逻辑 *****/
  function controlWaterSpray(outdoor_fin_temp, fan_speed, derating_flag, outdoor_status, spray_state) {
      if (!SYSTEM.features.water_spray_control) {
          return { active: false, state: {} };
      }

      if (outdoor_status !== "cool") {
          return { active: false, state: {} };
      }

      // 获取当前状态
      const current_state = spray_state || {};
      const spray_active = current_state.active || false;
      const start_cycle = current_state.start_cycle || 0;
      const stop_cycle = current_state.stop_cycle || 0;
      const start_temp = current_state.start_temp || outdoor_fin_temp;

      const current_cycle = flow.get('control_cycle') || 0;

      // 喷水器激活状态处理
      if (spray_active) {
          const spray_duration = current_cycle - start_cycle;
          const temp_drop = start_temp - outdoor_fin_temp;

          // 判断是否应该停止喷水
          let should_stop = false;
          let stop_reason = "";

          // 达到最长喷水时间
          if (spray_duration >= WATER_SPRAY.max_duration_cycles) {
              should_stop = true;
              stop_reason = "达到最长喷水时间";
          }
          // 温度已经下降到安全范围，且达到最短喷水时间
          else if (outdoor_fin_temp < WATER_SPRAY.stop_temp &&
              spray_duration >= WATER_SPRAY.min_duration_cycles) {
              // 额外检查：温度下降是否足够
              if (temp_drop >= WATER_SPRAY.temp_drop_threshold) {
                  should_stop = true;
                  stop_reason = `温度已降至${safeToFixed(outdoor_fin_temp)}℃，下降${safeToFixed(temp_drop)}℃`;
              }
          }

          if (should_stop) {
              debug(1, "喷水控制", `停止喷水: ${stop_reason}，已喷水${spray_duration}个周期`);
              return {
                  active: false,
                  state: {
                      active: false,
                      start_cycle: 0,
                      stop_cycle: current_cycle,
                      start_temp: 0
                  }
              };
          }

          // 继续喷水
          return {
              active: true,
              state: current_state
          };
      }
      // 喷水器未激活状态处理
      else {
          // 检查距离上次停止的间隔
          const cycles_since_stop = current_cycle - stop_cycle;

          // 检查是否满足启动条件
          const interval_ok = cycles_since_stop >= WATER_SPRAY.min_interval_cycles || stop_cycle === 0;
          const temp_high = outdoor_fin_temp >= WATER_SPRAY.trigger_temp;
          const fan_max = fan_speed === 255;
          const system_derating = derating_flag;

          // 综合判断是否需要喷水
          if (interval_ok && temp_high && fan_max && system_derating) {
              debug(1, "喷水控制", `开始喷水: 翅片温度=${safeToFixed(outdoor_fin_temp)}℃, ` +
                  `距上次喷水${cycles_since_stop}个周期`);
              return {
                  active: true,
                  state: {
                      active: true,
                      start_cycle: current_cycle,
                      stop_cycle: stop_cycle,
                      start_temp: outdoor_fin_temp
                  }
              };
          }

          // 保持关闭状态
          return {
              active: false,
              state: current_state
          };
      }
  }

  /***** 温度补偿计算 *****/
  function calculateCompensatedTemp(mode, target_temp, room_temp, return_temp, accumulated_comp) {
      if (!SYSTEM.features.temp_compensation) {
          return target_temp;
      }

      const comp_history = flow.get('comp_history') || {};
      const room_history = comp_history[`room_${room_temp}`] || {
          direction: 0,
          counter: 0,
          last_temp_diff: 0
      };

      let base_comp = 0;

      if (["cool", "dry", "comfort"].includes(mode)) {
          const temp_diff = return_temp - room_temp;
          let delta = Math.floor(temp_diff * TEMP_COMPENSATION.cooling.factor);
          delta = Math.max(delta, TEMP_COMPENSATION.cooling.max_negative);
          base_comp = delta;
      } else if (mode === "heat") {
          const temp_diff = return_temp - room_temp;
          let delta = temp_diff * TEMP_COMPENSATION.heating.factor;
          delta = Math.max(delta, TEMP_COMPENSATION.heating.min_positive);
          base_comp = delta;
      }

      let new_direction = room_history.direction;
      let new_counter = room_history.counter;

      const current_direction = base_comp > 0 ? 1 : (base_comp < 0 ? -1 : 0);

      if (current_direction !== 0) {
          if (room_history.direction === current_direction) {
              new_counter++;
          } else {
              new_direction = current_direction;
              new_counter = 1;
          }
      }

      let should_reset = false;
      if (new_counter >= TEMP_COMPENSATION.accumulated.reset_cycles &&
          Math.abs(accumulated_comp) > TEMP_COMPENSATION.penalty.threshold) {
          should_reset = true;
      }

      let apply_penalty = false;
      if (new_counter >= TEMP_COMPENSATION.penalty.cycles &&
          Math.abs(accumulated_comp) > TEMP_COMPENSATION.penalty.threshold &&
          (accumulated_comp > 0 && current_direction > 0 || accumulated_comp < 0 && current_direction < 0)) {
          apply_penalty = true;
      }

      comp_history[`room_${room_temp}`] = {
          direction: new_direction,
          counter: new_counter,
          last_temp_diff: base_comp
      };
      flow.set('comp_history', comp_history);

      let new_accumulated_comp = accumulated_comp;

      if (should_reset) {
          debug(1, "温度补偿", `重置累计补偿: 连续${new_counter}个周期方向一致(${new_direction > 0 ? '正' : '负'}), 补偿值=${safeToFixed(accumulated_comp, 2)}`);
          new_accumulated_comp = 0;
      }
      else if (apply_penalty) {
          const penalty = accumulated_comp * TEMP_COMPENSATION.penalty.factor;
          new_accumulated_comp -= penalty;
          debug(1, "温度补偿", `应用惩罚: 连续${new_counter}个周期补偿过大(${safeToFixed(accumulated_comp, 2)}), 减少${safeToFixed(penalty, 2)}`);
      }
      else if (base_comp !== 0) {
          new_accumulated_comp += (base_comp > 0 ?
              TEMP_COMPENSATION.accumulated.step :
              -TEMP_COMPENSATION.accumulated.step);
          new_accumulated_comp = Math.max(-TEMP_COMPENSATION.accumulated.max,
              Math.min(TEMP_COMPENSATION.accumulated.max, new_accumulated_comp));
      } else {
          if (new_accumulated_comp > 0) {
              new_accumulated_comp -= TEMP_COMPENSATION.accumulated.step;
          } else if (new_accumulated_comp < 0) {
              new_accumulated_comp += TEMP_COMPENSATION.accumulated.step;
          }
      }

      const total_comp = base_comp + new_accumulated_comp;
      let adjusted_temp = target_temp + total_comp;

      adjusted_temp = Math.max(16.0, Math.min(32.0, adjusted_temp));
      adjusted_temp = Math.round(adjusted_temp / TEMP_COMPENSATION.precision) * TEMP_COMPENSATION.precision;

      return {
          adjusted_temp: adjusted_temp,
          new_accumulated_comp: new_accumulated_comp,
          base_comp: base_comp,
          total_comp: total_comp
      };
  }

  /***** 计算系统期望功率 *****/
  function calculateExpectedPower(indoor_units, ventilation_status) {
      let base_power = POWER.base;

      let ventilation_power = 0;
      if (ventilation_status === "high") {
          ventilation_power = 100;
      } else if (ventilation_status === "low") {
          ventilation_power = 70;
      }

      let total_capacity = 0;
      let total_demand_power = 0;
      let total_fan_power = 0;
      let total_ptc_power = 0;

      for (const unit of indoor_units) {
          if (unit.mode === "off") continue;

          total_capacity += unit.capacity;
          total_fan_power += unit.fan_power;

          let base_factor = POWER.mode_factors[unit.mode] || 0;
          let capacity_factor = base_factor;
          const temp_diff = unit.temp_diff;

          if (unit.mode === "cool" || unit.mode === "comfort") {
              if (temp_diff < 0) {
                  capacity_factor = base_factor * (1.0 + (POWER.temp_diff_coef * Math.abs(temp_diff)));
              } else {
                  capacity_factor = base_factor * Math.max(0.2, 1.0 - (POWER.temp_diff_coef * temp_diff));
              }
          }
          else if (unit.mode === "heat") {
              if (temp_diff > 0) {
                  capacity_factor = base_factor * (1.0 + (POWER.temp_diff_coef * temp_diff));
              } else {
                  capacity_factor = base_factor * Math.max(0.2, 1.0 - (POWER.temp_diff_coef * Math.abs(temp_diff)));
              }
          }

          const unit_demand = unit.capacity * POWER.per_unit * capacity_factor;
          total_demand_power += unit_demand;

          if (ptcStatusToBool(unit.ptc_on)) {
              total_ptc_power += PTC.power;
              debug(2, "功率计算", `${unit.room_id} PTC已开启，添加${PTC.power}W功率`);
          }
      }

      if (total_capacity > POWER.rated_capacity) {
          const scale_factor = POWER.rated_capacity / total_capacity;
          debug(1, "功率计算", `系统超配: 总匹数=${safeToFixed(total_capacity, 1)}匹，缩放系数=${safeToFixed(scale_factor, 2)}`);
          total_demand_power *= scale_factor;
      }

      const outdoor_expected_power = total_demand_power;
      const total_expected_power = base_power + outdoor_expected_power + total_fan_power + ventilation_power + total_ptc_power;

      return {
          total: Math.max(0, total_expected_power),
          outdoor: Math.max(0, outdoor_expected_power),
          fan: total_fan_power,
          ventilation: ventilation_power,
          base: base_power,
          ptc: total_ptc_power,
          capacity: total_capacity
      };
  }

  /***** 检测系统是否降频 *****/
  function detectDerating(outdoor_fin_temp, system_power, expected_power, device_room_temp, outdoor_status) {
      if (outdoor_status === "heat") {
          return false;
      }

      const derating_data = flow.get('derating_data') || { count: 0, check_counter: 0 };
      let { count, check_counter } = derating_data;

      check_counter++;
      if (check_counter < POWER.derating.check_interval) {
          flow.set('derating_data', { count, check_counter });
          return count >= POWER.derating.count_required;
      }

      check_counter = 0;
      let is_derating = false;

      if (expected_power.outdoor > 0) {
          const power_ratio = system_power / expected_power.outdoor;
          const temp_condition = (outdoor_fin_temp >= WATER_SPRAY.trigger_temp);
          const power_condition = (power_ratio < POWER.derating.threshold);
          const room_temp_high = (device_room_temp >= FAN.room.max_temp);

          const current_derating = (temp_condition && power_condition) || room_temp_high;

          if (current_derating) {
              count++;
          } else {
              count = Math.max(0, count - 1);
          }

          flow.set('derating_data', { count, check_counter });

          is_derating = (count >= POWER.derating.count_required);

          if (room_temp_high) {
              is_derating = true;
              debug(1, "降频检测", `设备房温度过高(${safeToFixed(device_room_temp)}℃)，强制判定为降频状态！`);
          }

          if (is_derating) {
              debug(1, "降频检测", `检测到系统降频: 翅片温度=${safeToFixed(outdoor_fin_temp)}℃, ` +
                  `功率比=${safeToFixed(power_ratio, 2)}, 累计次数=${count}`);
          }
      }

      return is_derating;
  }

  /***** 处理单个房间的内机 *****/
  function processRoomUnit(room_id, outdoor_status, ptc_global_enabled, active_units) {
      const unit_config = INDOOR_UNITS[room_id];

      if (!unit_config) {
          debug(1, room_id, "未找到内机配置，跳过处理");
          return null;
      }

      const capacity = unit_config.capacity;
      const fan_power = unit_config.fan_power;
      const ptc_enabled = unit_config.ptc_enabled && ptc_global_enabled;

      if (!unit_config.has_external_panel) {
          const inner_mode = flow.get(`${room_id}_inner_mode`) || "off";
          const return_temp = flow.get(`${room_id}_return_temp`) || 25;
          const target_temp = flow.get(`${room_id}_target_temp`) || 25;
          const ptc_hardware_status = flow.get(`${room_id}_ptc_hardware_status`) || false;

          if (inner_mode === "off") {
              return null;
          }

          return {
              room_id,
              capacity,
              mode: inner_mode,
              temp_diff: target_temp - return_temp,
              ptc_on: ptc_hardware_status,
              fan_power
          };
      }

      debug(2, room_id, `开始处理...`);

      const panel_mode = flow.get(`${room_id}_panel_mode`) || "off";
      const prev_panel_mode = flow.get(`${room_id}_prev_panel_mode`) || "off";
      const inner_mode = flow.get(`${room_id}_inner_mode`) || "off";
      const return_temp = Number(flow.get(`${room_id}_return_temp`) || 25);
      const room_temp = Number(flow.get(`${room_id}_room_temp`) || 25);
      const target_temp = Number(flow.get(`${room_id}_target_temp`) || 25);
      const panel_fan_mode = flow.get(`${room_id}_fan_mode`) || "auto";
      const prev_fan_mode = flow.get(`${room_id}_prev_fan_mode`) || "auto";

      const raw_ptc_func_status = flow.get(`${room_id}_ptc_func_status`);
      const raw_ptc_hardware_status = flow.get(`${room_id}_ptc_hardware_status`);
      const ptc_func_status = ptcStatusToBool(raw_ptc_func_status);
      const ptc_hardware_status = ptcStatusToBool(raw_ptc_hardware_status);

      ptcDebug(room_id, `原始状态: 功能=${raw_ptc_func_status}(${typeof raw_ptc_func_status}), ` +
          `硬件=${raw_ptc_hardware_status}(${typeof raw_ptc_hardware_status})`);
      ptcDebug(room_id, `转换状态: 功能=${ptc_func_status}(${typeof ptc_func_status}), ` +
          `硬件=${ptc_hardware_status}(${typeof ptc_hardware_status})`);

      const ptc_retry_count = Number(flow.get(`${room_id}_ptc_retry_count`) || 0);
      const shutdown_pending = flow.get(`${room_id}_shutdown_pending`) || false;

      const accumulated_comp = Number(flow.get(`${room_id}_accumulated_comp`) || 0);

      flow.set(`${room_id}_prev_panel_mode`, panel_mode);
      flow.set(`${room_id}_prev_fan_mode`, panel_fan_mode);

      let adjusted_temp = null;
      let sync_mode = null;
      let sync_fan = null;
      let ptc_operation = null;
      let override_panel_mode = null;
      let override_fan = null;
      let shutdown = false;

      if (shutdown_pending && inner_mode !== "off") {
          debug(1, room_id, `[关机确认] 上一轮关机指令未成功执行，再次发送关机指令`);
          shutdown = true;
          flow.set(`${room_id}_shutdown_pending`, true);
      } else if (shutdown_pending) {
          flow.set(`${room_id}_shutdown_pending`, false);
          debug(2, room_id, `[关机确认] 关机成功`);
      }

      let panel_error = false;
      if (panel_mode !== "off" && !["cool", "heat", "dry", "fan_only", "fan", "auto", "comfort"].includes(panel_mode)) {
          debug(1, room_id, `[错误] 面板模式无效: ${panel_mode}`);
          panel_error = true;
      }

      if (panel_error) {
          debug(1, room_id, `检测到面板状态错误，强制关机`);
          shutdown = true;
          ptc_operation = "off";
          flow.set(`${room_id}_ptc_retry_count`, 0);
          flow.set(`${room_id}_shutdown_pending`, true);

          return {
              room_id,
              capacity,
              mode: inner_mode,
              temp_diff: target_temp - return_temp,
              ptc_on: ptc_hardware_status,
              fan_power
          };
      }

      const hidden_mode_active = (panel_mode === "off" && inner_mode !== "off" && prev_panel_mode === "off");

      if (hidden_mode_active) {
          const valid_hidden_mode = (inner_mode === "fan_only" && !ptc_func_status) || inner_mode === "dry";

          if (!valid_hidden_mode) {
              debug(1, room_id, `[隐藏模式] 检测到非法隐藏模式: ${inner_mode}，强制关机`);
              shutdown = true;
              ptc_operation = "off";
              flow.set(`${room_id}_shutdown_pending`, true);
          } else {
              debug(1, room_id, `[隐藏模式] 有效模式: ${inner_mode}`);
              adjusted_temp = target_temp;
              sync_fan = "auto";
              sync_mode = null;
          }
      }
      else if (panel_mode !== "off") {
          let has_mode_authority = false;

          const _roomsArr = (active_units && Array.isArray(active_units.rooms)) ? active_units.rooms : [];
          if (active_units && active_units.count === 1 && _roomsArr.includes(room_id)) {
              has_mode_authority = true;
              debug(1, room_id, `[冷热选择权] 作为唯一运行的内机，拥有冷热选择权`);
          }

          if (outdoor_status === "heat" && panel_mode !== "heat" && !has_mode_authority) {
              debug(1, room_id, `[强制同步] 外机制热模式，面板为${panel_mode}模式，强制覆盖为制热模式`);
              sync_mode = "heat";
              override_panel_mode = "heat";
          }
          else {
              if (panel_mode === "dry") {
                  sync_mode = "comfort";
                  debug(2, room_id, `[模式转换] 面板除湿模式转换为内机舒适模式`);
              } else if (panel_mode === "fan" || panel_mode === "fan_only") {
                  sync_mode = "fan_only";
                  debug(2, room_id, `[模式转换] 面板送风模式转换为标准送风模式(fan_only)`);
              } else {
                  sync_mode = panel_mode;
              }
          }

          if (ptc_enabled) {
              ptcDebug(room_id, `PTC处理: 面板模式=${panel_mode}, 外机状态=${outdoor_status}, 功能状态=${ptc_func_status}, 重试计数=${ptc_retry_count}`);

              if (ptc_func_status && (panel_mode !== "heat" || outdoor_status !== "cool")) {
                  ptcDebug(room_id, `模式切换：关闭PTC功能 - 面板模式=${panel_mode}, 外机状态=${outdoor_status}`);
                  ptc_operation = "off";
                  flow.set(`${room_id}_ptc_retry_count`, 0);
              }
              else if (panel_mode === "heat" && outdoor_status === "cool" && !ptc_func_status) {
                  if (ptc_retry_count < PTC.retry_max) {
                      ptc_operation = "on";
                      flow.set(`${room_id}_ptc_retry_count`, ptc_retry_count + 1);
                      ptcDebug(room_id, `发送功能开启命令，尝试次数: ${ptc_retry_count + 1}/${PTC.retry_max}`);
                      sync_mode = "fan_only";
                  }
                  else if (ptc_retry_count >= PTC.retry_max) {
                      ptcDebug(room_id, `功能开启失败(已尝试${ptc_retry_count}次)，切换为制冷模式`);
                      ptc_operation = "off";
                      sync_mode = "cool";
                      override_panel_mode = "cool";
                      flow.set(`${room_id}_ptc_retry_count`, 0);
                  }
              }
              else if (ptc_func_status && inner_mode === "fan_only") {
                  ptcDebug(room_id, `功能已开启，内机保持送风模式`);
                  sync_mode = "fan_only";
                  override_panel_mode = "heat";
                  override_fan = "auto";
                  adjusted_temp = target_temp;
                  flow.set(`${room_id}_ptc_retry_count`, 0);
              }
              else {
                  flow.set(`${room_id}_ptc_retry_count`, 0);
              }
          }

          if (!ptc_func_status && adjusted_temp === null) {
              const prev_inner_mode = flow.get(`${room_id}_prev_inner_mode`) || inner_mode;
              if (prev_inner_mode !== sync_mode) {
                  debug(1, room_id, `[温度补偿] 模式变化(${prev_inner_mode}→${sync_mode})，重置累计温度补偿`);
                  flow.set(`${room_id}_accumulated_comp`, 0);
                  flow.set(`${room_id}_prev_inner_mode`, sync_mode);
              }

              const comp_result = calculateCompensatedTemp(
                  sync_mode,
                  target_temp,
                  room_temp,
                  return_temp,
                  accumulated_comp
              );

              adjusted_temp = comp_result.adjusted_temp;
              flow.set(`${room_id}_accumulated_comp`, comp_result.new_accumulated_comp);

              debug(2, room_id, `[温度补偿] 基础补偿: ${comp_result.base_comp}°C, ` +
                  `累计: ${safeToFixed(comp_result.new_accumulated_comp, 1)}°C, ` +
                  `总补偿: ${safeToFixed(comp_result.total_comp, 1)}°C, ` +
                  `调整后: ${adjusted_temp}°C`);
          }

          if (!ptc_func_status && sync_fan === null) {
              const fan_mode_changed = panel_fan_mode !== prev_fan_mode;

              const prev_inner_mode = flow.get(`${room_id}_prev_inner_mode`) || inner_mode;
              if (prev_inner_mode !== sync_mode) {
                  debug(1, room_id, `[风速控制] 模式变化(${prev_inner_mode}→${sync_mode})，重置风速相关变量`);
                  flow.set(`${room_id}_accum_temp_diff`, 0);
                  flow.set(`${room_id}_fan_samples`, []);
                  flow.set(`${room_id}_fan_change_counter`, 0);
                  flow.set(`${room_id}_opposite_diff_counter`, 0);
                  flow.set(`${room_id}_force_reset_counter`, 0);
              }

              if (panel_fan_mode !== "auto") {
                  if (fan_mode_changed) {
                      flow.set(`${room_id}_accum_temp_diff`, 0);
                      flow.set(`${room_id}_fan_samples`, []);
                      flow.set(`${room_id}_fan_change_counter`, 0);
                      flow.set(`${room_id}_opposite_diff_counter`, 0);
                      flow.set(`${room_id}_force_reset_counter`, 0);
                      debug(1, room_id, `[风速控制] 切换至手动风速模式: ${panel_fan_mode}`);
                  }
                  sync_fan = FAN_SPEED.panel_to_indoor[panel_fan_mode] || panel_fan_mode;
                  debug(2, room_id, `[风速控制] 手动风速模式，面板风速=${panel_fan_mode}, 内机风速=${sync_fan}`);
              }
              else if (SYSTEM.features.auto_fan_control) {
                  if (fan_mode_changed && prev_fan_mode !== "auto") {
                      flow.set(`${room_id}_accum_temp_diff`, 0);
                      flow.set(`${room_id}_fan_samples`, []);
                      flow.set(`${room_id}_fan_change_counter`, 0);
                      flow.set(`${room_id}_opposite_diff_counter`, 0);
                      flow.set(`${room_id}_force_reset_counter`, 0);
                      debug(1, room_id, `[风速控制] 切换至自动风速模式`);
                  }

                  const temp_diff = target_temp - room_temp;
                  sync_fan = getFanSpeedForTempDiff(room_id, temp_diff, sync_mode === "heat");
                  debug(2, room_id, `[风速控制] 自动风速模式，温差=${temp_diff}°C, 选择风速=${sync_fan}`);
              } else {
                  sync_fan = "auto";
                  debug(2, room_id, `[风速控制] 自动风速功能已关闭，使用内机默认自动档`);
              }
          }
      }
      else if (panel_mode === "off" && prev_panel_mode !== "off") {
          debug(1, room_id, `[关机] 检测到面板关机指令`);
          shutdown = true;
          ptc_operation = "off";
          flow.set(`${room_id}_ptc_retry_count`, 0);
          flow.set(`${room_id}_shutdown_pending`, true);

          flow.set(`${room_id}_accumulated_comp`, 0);
          flow.set(`${room_id}_accum_temp_diff`, 0);
          flow.set(`${room_id}_fan_samples`, []);
          flow.set(`${room_id}_fan_change_counter`, 0);
          flow.set(`${room_id}_opposite_diff_counter`, 0);
          flow.set(`${room_id}_force_reset_counter`, 0);
      }

      flow.set(`${room_id}_adjusted_temp`, adjusted_temp);
      flow.set(`${room_id}_sync_mode`, sync_mode);
      flow.set(`${room_id}_sync_fan`, sync_fan);
      flow.set(`${room_id}_ptc_operation`, ptc_operation);
      flow.set(`${room_id}_override_panel_mode`, override_panel_mode);
      flow.set(`${room_id}_override_fan`, override_fan);
      flow.set(`${room_id}_shutdown`, shutdown);

      debug(2, room_id, `处理完成: 温度=${adjusted_temp}, 模式=${sync_mode}, ` +
          `风速=${sync_fan}, PTC操作=${ptc_operation}, ` +
          `覆盖模式=${override_panel_mode}, 覆盖风速=${override_fan}, 关机=${shutdown}`);

      return {
          room_id,
          capacity,
          mode: inner_mode,
          temp_diff: target_temp - return_temp,
          ptc_on: ptc_hardware_status,
          fan_power
      };
  }

  /***** 主控制函数 *****/
  function mainControl() {
      const control_cycle = (flow.get('control_cycle') || 0) + 1;
      flow.set('control_cycle', control_cycle);

      debug(1, "系统", "=== 开始空调控制循环 ===");

      if (!SYSTEM.active) {
          debug(1, "系统", "系统未激活，跳过控制");
          node.status({ fill: "grey", shape: "dot", text: "系统未激活" });
          return { system_inactive: true };
      }

      const outdoor_status = determineOutdoorStatus();
      debug(1, "系统状态", `外机当前状态: ${outdoor_status}`);

      const active_units = getActiveIndoorUnits();

      // ✅ 全部内机关机后：重置关键累积状态，避免“关机后不重置/再次启动跳变”
      const _prevActiveCount = Number(flow.get('prev_active_count') || 0);
      if (_prevActiveCount > 0 && active_units.count === 0) {
          debug(1, "系统状态", `检测到全部内机关机（${_prevActiveCount}→0），重置累积状态`);
          // 重置房间级状态
          for (const room_id in INDOOR_UNITS) {
              flow.set(`${room_id}_accumulated_comp`, 0);
              flow.set(`${room_id}_accum_temp_diff`, 0);
              flow.set(`${room_id}_fan_samples`, []);
              flow.set(`${room_id}_fan_change_counter`, 0);
              flow.set(`${room_id}_opposite_diff_counter`, 0);
              flow.set(`${room_id}_force_reset_counter`, 0);

              flow.set(`${room_id}_ptc_retry_count`, 0);
              flow.set(`${room_id}_shutdown_pending`, false);
              flow.set(`${room_id}_ptc_state_data`, null);

              flow.set(`${room_id}_ptc_operation`, "off");
              flow.set(`${room_id}_ptc_hardware_command`, false);
          }
          // 重置全局状态
          flow.set('comp_history', {});
          flow.set('derating_data', { count: 0, check_counter: 0 });
          flow.set('spray_state', { active: false, start_cycle: 0, stop_cycle: 0, start_temp: 0 });
          flow.set('fan_state', { adjustment_counter: 0 });
      }
      flow.set('prev_active_count', active_units.count);

      debug(1, "系统状态", `活跃内机: ${active_units.count}台，制热:${active_units.heatingCount}台，制冷:${active_units.coolingCount}台`);

      let outdoor_fin_temp = Number(flow.get('outdoor_fin_temp'));
      if (isNaN(outdoor_fin_temp)) {
          outdoor_fin_temp = 35.0;
          debug(1, "输入数据", `翅片温度无效，使用默认值: ${outdoor_fin_temp}℃`);
      }

      let system_power = Number(flow.get('system_power'));
      if (isNaN(system_power)) {
          system_power = 0;
          debug(1, "输入数据", `系统功率无效，使用默认值: ${system_power}W`);
      }

      let device_room_temp = Number(flow.get('device_room_temp'));
      if (isNaN(device_room_temp)) {
          device_room_temp = 25.0;
          debug(1, "输入数据", `设备房温度无效，使用默认值: ${device_room_temp}℃`);
      }

      const ventilation_status = flow.get('ventilation_status') || "off";
      const current_fan_speed = flow.get('fan_speed') || 0;
      const fan_power_switch = flow.get('fan_power_switch') || false;
      const floor_heating_on = flow.get('floor_heating_on') || false;

      const ptc_global_enabled = PTC.global_enabled;

      const indoor_units = [];

      for (const room_id in INDOOR_UNITS) {
          const unit = processRoomUnit(room_id, outdoor_status, ptc_global_enabled, active_units);
          if (unit) {
              indoor_units.push(unit);
          }
      }

      const expected_power = calculateExpectedPower(indoor_units, ventilation_status);
      debug(1, "功率计算", `系统期望功率: ${safeToFixed(expected_power.total)}W, ` +
          `外机功率: ${safeToFixed(expected_power.outdoor)}W, ` +
          `实际功率: ${safeToFixed(system_power)}W`);

      const derating_flag = detectDerating(
          outdoor_fin_temp,
          system_power,
          expected_power,
          device_room_temp,
          outdoor_status
      );

      let ventilation_mode = null;
      if (SYSTEM.features.new_ventilation) {
          ventilation_mode = determineVentilationMode();
      }

      // 获取风扇状态对象
      const fan_state = flow.get('fan_state') || {};

      let target_fan_speed = calculateFanSpeed(outdoor_fin_temp, outdoor_status, device_room_temp);
      let fan_speed_set = smoothFanSpeedAdjustment(current_fan_speed, target_fan_speed, fan_state);

      // 保存风扇状态
      flow.set('fan_state', fan_state);

      let fan_power_set = (fan_speed_set > 0);

      // 获取喷水器状态对象
      const spray_state = flow.get('spray_state') || {};

      let spray_result = {
          active: false,
          state: spray_state
      };

      if (SYSTEM.features.water_spray_control) {
          spray_result = controlWaterSpray(
              outdoor_fin_temp,
              fan_speed_set,
              derating_flag,
              outdoor_status,
              spray_state
          );
      }

      // 保存喷水器状态
      flow.set('water_spray_set', spray_result.active);
      flow.set('spray_state', spray_result.state);

      flow.set('fan_speed_set', fan_speed_set);
      flow.set('fan_power_switch_set', fan_power_set);

      flow.set('expected_power', expected_power.total);
      flow.set('expected_outdoor_power', expected_power.outdoor);

      flow.set('derating_flag', derating_flag);

      // ✅ file13 习惯：new_ventilation_mode 表示“期望的新风模式”，
      //    ventilation_mode_set 则是“已经成功下发过的模式”（由发送函数在下发后写入）
      //    这样才能做到：只在变化时下发，避免每轮都重复发送。
      flow.set('new_ventilation_mode', ventilation_mode);


      debug(1, "系统", "=== 空调控制循环完成 ===");

      // 计算喷水器运行时间（秒）
      let spray_duration_sec = 0;
      if (spray_result.active && spray_result.state.start_cycle) {
          spray_duration_sec = (control_cycle - spray_result.state.start_cycle) * (SYSTEM.execution_period_ms / 1000);
      }

      // 显示状态
      let status_text = "";

      // 外机状态
      if (outdoor_status === "off") {
          status_text = "外机:关闭";
      } else {
          status_text = `外机:${outdoor_status === "cool" ? "制冷" : "制热"}`;
      }

      // 内机数量
      status_text += ` | 内机:${active_units.count}台`;

      // 喷水器状态
      if (spray_result.active) {
          status_text += ` | 喷水:${Math.floor(spray_duration_sec)}秒`;
      }

      // 风扇状态
      if (fan_power_set) {
          const fan_percent = Math.round((fan_speed_set / 255) * 100);
          status_text += ` | 风扇:${fan_percent}%`;
      }

      // 降频状态
      if (derating_flag) {
          status_text += " | 降频";
      }

      // 设置节点状态
      const fill = outdoor_status === "off" ? "grey" : (outdoor_status === "cool" ? "blue" : "red");
      node.status({ fill: fill, shape: "dot", text: status_text });

      return {
          fan_speed_set,
          fan_power_switch_set: fan_power_set,
          water_spray_set: spray_result.active,
          expected_power: expected_power.total,
          expected_outdoor_power: expected_power.outdoor,
          derating_flag,
          ventilation_mode_set: ventilation_mode
      };
  }

  // 执行主控制函数并返回结果
  const result = mainControl();

  return result;

} // end runMainControlV41

/** =========================
 *  6) PTC 联动控制算法（直接内嵌「PTC联动控制系统」原代码）
 *  ========================= */
function runPTCLinkedControl() {
  // PTC 原代码需要一个 msg 变量（它最终会 return msg，并把 responses 放到 msg.payload）
  let msg = { payload: {} };

  /**
   * PTC (Positive Temperature Coefficient) 加热控制功能节点
   * 
   * 此函数每10秒执行一次，管理PTC加热元件和空调模式设置，
   * 根据室温和目标温度提供高效加热，同时确保安全和舒适度。
   * 
   * 功能特点:
   * - 基于温度差的PTC自动控制，达到目标温度时自动关闭
   * - 根据温度差自动调节风速提高舒适度
   * - 安全联锁机制确保PTC仅在风扇模式下运行
   * - 详细的调试日志记录
   * - 温度变化累积计算处理整数精度问题
   * 
   * 版本: 1.0.0
   */
  function PTCController(msg) {
      // ==================== 配置部分 ====================
      /**
       * 配置对象，包含所有可调节参数
       */
      const config = {
          // 调试设置 - 控制日志消息的详细程度
          debug: {
              enabled: false,           // 主调试开关 - 设为false禁用所有调试消息
              logLevel: "detailed"       // 日志级别: "minimal", "normal", "detailed"
          },
          // PTC控制设置 - 调整这些参数以微调系统行为
          ptc: {
              forceShutdownDelay: 3,      // 检测到安全问题时，等待几个周期后强制模式更改
              tempShutdownThreshold: 0.5, // 温度(°C)高于目标温度多少时自动关闭PTC
              tempEnableHysteresis: 0.5,  // 温度(°C)低于目标温度多少时重新启用PTC
              tempAccumulationFactor: 0.3 // 温度变化累积权重因子(0-1)
              // 值越高，系统对最近变化越敏感
              // 值越低，系统运行越稳定
          },
          // 房间配置 - 每次执行时要处理的房间列表
          rooms: [
              "diningroom", "kitchen", "washroom",
              "bedroom2", "bedroom3", "bedroom1",
              "2faisle", "livingroom", "bedroom1f"
          ],
          // 风速映射表 - 基于温度差的风速调整
          // 定义根据目标温度和当前温度之间的差异应如何调整风速
          fanSpeedMap: [
              { diff: 1.0, speed: "medium" },  // 温差不超过1.0°C，使用中速
              { diff: 2.0, speed: "稍强" },    // 温差1.0-2.0°C，使用中高速
              { diff: 999, speed: "high" }      // 温差>2.0°C，使用高速
          ],
          // 默认值（当流变量未设置时）
          defaults: {
              roomTemp: 26,       // 默认房间温度(°C)
              targetTemp: 26,     // 默认目标温度(°C)
              innerMode: "off",   // 默认内机模式
              fanSpeed: "medium"  // 默认风速
          }
      };
      // ==================== 工具函数 ====================
      /**
       * 将可能的字符串状态转换为布尔值
       * 支持 true/false, "true"/"false", "on"/"off", 1/0 等形式
       * 
       * @param {any} status - 输入的状态值
       * @return {boolean} 转换后的布尔值
       */
      function toBooleanState(status) {
          if (typeof status === 'boolean') return status;
          if (typeof status === 'number') return status !== 0;
          if (typeof status === 'string') {
              const normalized = status.toLowerCase().trim();
              return normalized === 'on' || normalized === 'true' || normalized === '1';
          }
          return Boolean(status); // 默认转换
      }
      /**
       * 记录房间调试信息
       * 根据配置的详细程度输出房间状态信息
       * 
       * @param {string} room - 房间标识符
       * @param {object} data - 包含房间状态数据的对象
       */
      function logRoomDebug(room, data) {
          if (!config.debug.enabled) return;
          const {
              ptcFuncStatus, ptcHardwareStatus, roomTemp, targetTemp, innerMode,
              syncMode, syncFan, ptcCommand, action, tempDiff, tempAccumulator,
              cycleCount, shutdown
          } = data;
          let message;
          // 根据日志级别确定输出详细程度
          if (config.debug.logLevel === "minimal") {
              message = `${room}: 操作=${action}, 室温=${roomTemp}°C, 目标=${targetTemp}°C, PTC=${ptcCommand}`;
          }
          else if (config.debug.logLevel === "detailed") {
              message = [
                  `=== ${room} 状态详情 (周期 #${cycleCount}) ===`,
                  `温度: 室温=${roomTemp}°C, 目标=${targetTemp}°C, 差值=${tempDiff.toFixed(2)}°C`,
                  `温度累积变化: ${tempAccumulator.toFixed(2)}°C`,
                  `PTC: 功能=${ptcFuncStatus}, 硬件=${ptcHardwareStatus}, 命令=${ptcCommand}`,
                  `空调: 当前模式=${innerMode}, 同步模式=${syncMode}, 风速=${syncFan}`,
                  `系统: 关机标志=${shutdown}`,
                  `执行操作: ${action}`
              ].join('\n');
          }
          else { // normal
              message = [
                  `--- ${room} 状态 ---`,
                  `温度: 室温=${roomTemp}°C, 目标=${targetTemp}°C, 差值=${tempDiff.toFixed(2)}°C`,
                  `PTC: 功能=${ptcFuncStatus}, 硬件=${ptcHardwareStatus}, 命令=${ptcCommand}`,
                  `空调: 模式=${innerMode}->${syncMode}, 风速=${syncFan}`,
                  `操作: ${action}`
              ].join('\n');
          }
          node.warn(`[PTC控制] ${message}`);
      }
      /**
       * 获取流变量，提供默认值回退
       * 安全地检索流变量，如果未找到则提供默认值
       * 
       * @param {string} name - 要检索的流变量名称
       * @param {any} defaultValue - 如果变量未找到时返回的默认值
       * @return {any} 变量值或默认值
       */
      function getFlowVar(name, defaultValue) {
          const value = flow.get(name);
          return (value !== undefined && value !== null) ? value : defaultValue;
      }
      // ==================== 主处理逻辑 ====================
      if (config.debug.enabled) {
          node.warn(`[PTC控制] 开始PTC控制处理周期`);
      }
      // 初始化响应消息数组以收集结果
      const responses = [];
      // 处理配置中的每个房间
      for (const room of config.rooms) {
          try {
              processRoom(room, responses);
          } catch (error) {
              node.warn(`[PTC控制] 处理房间${room}时出错: ${error.message}`);
          }
      }
      // 设置最终响应消息
      msg.payload = responses;
      return msg;
      // ==================== 房间处理函数 ====================
      /**
       * 处理单个房间的PTC和空调控制逻辑
       * 
       * @param {string} room - 房间标识符
       * @param {Array} responses - 收集响应数据的数组
       */
      function processRoom(room, responses) {
          // 从流变量读取当前状态
          const ptcFuncStatus = toBooleanState(getFlowVar(`${room}_ptc_func_status`, false));  // PTC功能启用标志
          const ptcHardwareStatus = toBooleanState(getFlowVar(`${room}_ptc_hardware_status`, false));  // 当前PTC硬件状态
          const roomTemp = getFlowVar(`${room}_room_temp`, config.defaults.roomTemp);  // 当前室温
          const targetTemp = getFlowVar(`${room}_target_temp`, config.defaults.targetTemp);  // 目标温度
          const innerMode = getFlowVar(`${room}_inner_mode`, config.defaults.innerMode);  // 当前空调内机模式
          const shutdown = toBooleanState(getFlowVar(`${room}_shutdown`, false));  // 关机标志
          // 获取存储的状态数据或初始化新状态对象
          // 此持久状态存储在flow中以跟踪执行之间的变化
          let stateData = getFlowVar(`${room}_ptc_state_data`, {
              shutdownCounter: 0,        // 强制关机逻辑计数器
              tempAccumulator: 0,        // 累积温度变化(帮助处理整数精度)
              lastRoomTemp: roomTemp,    // 上一次的室温
              autoShutOff: false,        // 自动关闭状态标志
              cycleCount: 0              // 此房间的周期计数器
          });
          // 更新周期计数用于跟踪
          stateData.cycleCount++;
          // 使用当前值初始化控制变量
          let syncMode = innerMode;  // 要同步到空调的模式
          let syncFan = config.defaults.fanSpeed;  // 要设置的风速
          let ptcCommand = ptcHardwareStatus;  // 要发送的PTC命令
          let actionTaken = "none";  // 跟踪操作以便报告
          let modeChanged = false;   // 标记是否需要写入模式变更
          let fanChanged = false;    // 标记是否需要写入风速变更

          // 计算温度差和与上次读数的变化
          const tempDiff = targetTemp - roomTemp;  // 正值表示需要加热
          const tempChange = roomTemp - stateData.lastRoomTemp;  // 正值表示温度上升
          // 使用新变化的加权平均值更新温度累加器
          // 这有助于平滑温度读数中的整数精度问题
          stateData.tempAccumulator = (stateData.tempAccumulator * (1 - config.ptc.tempAccumulationFactor)) +
              (tempChange * config.ptc.tempAccumulationFactor);
          // ==================== 控制逻辑 ====================
          // 安全检查始终执行: 
          // 如果PTC硬件已启用但内机模式不是fan_only，则强制关闭PTC硬件
          if (ptcHardwareStatus && innerMode !== "fan_only") {
              ptcCommand = false;  // 安全关闭PTC
              actionTaken = "safety_ptc_off";
              // 如果PTC功能启用，启动关机计数器以便在需要时强制模式更改
              if (ptcFuncStatus) {
                  stateData.shutdownCounter++;
                  // 经过一定周期后，强制模式更改
                  if (stateData.shutdownCounter >= config.ptc.forceShutdownDelay) {
                      // 延迟后强制更改为fan_only
                      syncMode = "fan_only";
                      modeChanged = true;
                      actionTaken = "force_fan_only";
                  }
              }
          } else {
              stateData.shutdownCounter = 0;  // 安全状态下重置计数器
          }
          // 情况1: 系统请求关机且PTC功能关闭
          // 在这种情况下，我们关闭整个系统
          if (shutdown && !ptcFuncStatus) {
              syncMode = "off";  // 关闭空调
              modeChanged = true;
              ptcCommand = false;  // 关闭PTC
              actionTaken = "shutdown";
          }
          // 情况2: PTC功能激活
          // 这是加热的主要操作模式
          else if (ptcFuncStatus) {
              // PTC功能激活时始终设置为fan_only模式
              // 这确保PTC加热的适当空气循环
              syncMode = "fan_only";
              modeChanged = true;

              // 根据温度差确定风速
              syncFan = determineFanSpeed(tempDiff);
              fanChanged = true;

              // 只有当内机模式为fan_only时才考虑PTC温控逻辑
              if (innerMode === "fan_only") {
                  // 自动温控逻辑
                  // 根据当前温度管理PTC
                  // 如果房间温度达到或高于目标温度+阈值
                  if (tempDiff <= -config.ptc.tempShutdownThreshold) {
                      // 房间温度高于目标温度(按阈值调整)
                      if (!stateData.autoShutOff) {
                          stateData.autoShutOff = true;
                      }
                      ptcCommand = false;  // 关闭PTC以防止过热
                      actionTaken = "auto_ptc_off_temp_reached";
                  }
                  // 如果PTC处于自动关闭状态但温度已降至低于滞后值
                  else if (stateData.autoShutOff && tempDiff >= config.ptc.tempEnableHysteresis) {
                      // 房间已冷却至低于滞后值，重新启用PTC
                      stateData.autoShutOff = false;
                      ptcCommand = true;  // 重新打开PTC
                      actionTaken = "auto_ptc_on_temp_dropped";
                  }
                  // 正常加热操作(低于目标温度且不在自动关闭状态)
                  else if (!stateData.autoShutOff) {
                      // 正常加热操作
                      ptcCommand = true;
                      actionTaken = "normal_heating";
                  }
                  // 维持自动关闭状态(我们仍处于滞后范围内)
                  else {
                      ptcCommand = false;
                      actionTaken = "maintain_auto_off";
                  }
              }
          }
          // 情况3: PTC功能未激活(但不是关机)
          // 在这种情况下，我们只确保PTC关闭但不更改空调模式或风速
          else {
              // 保持当前模式，关闭PTC硬件
              ptcCommand = false;
              actionTaken = "ptc_func_off";
          }
          // ==================== 更新流变量 ====================
          // 仅当需要改变模式(安全需要或PTC功能开启)时才写入模式
          if (modeChanged) {
              flow.set(`${room}_sync_mode`, syncMode);
          }

          // 仅当PTC功能开启且风速改变时才写入风速
          if (ptcFuncStatus && fanChanged) {
              flow.set(`${room}_sync_fan`, syncFan);
          }

          // 仅当与当前状态不同时才更新PTC硬件命令
          // 这可防止发送不必要的命令
          if (ptcCommand !== ptcHardwareStatus) {
              // 确保输出是布尔值
              flow.set(`${room}_ptc_hardware_command`, Boolean(ptcCommand));
          }
          // 更新流中的状态数据以供下次执行
          stateData.lastRoomTemp = roomTemp;
          flow.set(`${room}_ptc_state_data`, stateData);
          // 收集所有状态数据用于调试和响应
          const roomData = {
              room,                     // 房间标识符
              ptcFuncStatus,            // PTC功能状态(开/关)
              ptcHardwareStatus,        // 当前PTC硬件状态
              roomTemp,                 // 当前室温
              targetTemp,               // 目标温度
              innerMode,                // 当前内机模式
              syncMode,                 // 正在发送的模式命令
              syncFan,                  // 正在设置的风速
              ptcCommand,               // 正在发送的PTC命令
              action: actionTaken,      // 操作描述
              tempDiff,                 // 温度差
              tempAccumulator: stateData.tempAccumulator,  // 累积温度变化
              cycleCount: stateData.cycleCount,  // 执行周期计数
              shutdown                  // 关机标志
          };
          // 输出房间调试信息
          logRoomDebug(room, roomData);
          // 添加响应以供报告
          // 这收集所有相关数据以进行监控和调试
          responses.push(roomData);
      }
      // ==================== 辅助函数 ====================
      /**
       * 根据温度差确定风速
       * 
       * @param {number} tempDiff - 目标温度与当前温度之间的差异
       * @return {string} 要设置的风速
       */
      function determineFanSpeed(tempDiff) {
          // 使用温差的绝对值
          // 这适用于加热和制冷场景
          const absDiff = Math.abs(tempDiff);
          // 从映射表中找到适当的风速
          for (const map of config.fanSpeedMap) {
              if (absDiff <= map.diff) {
                  return map.speed;
              }
          }
          // 如果没有匹配项，默认为中速(有999的兜底值应该不会发生)
          return config.defaults.fanSpeed;
      }
  }
  // 导出node-red函数
  return PTCController(msg);
  /**
   * === 输入变量 ===
   * {room}_ptc_func_status: 布尔或字符串("on"/"off"), PTC功能状态(开关)
   * {room}_ptc_hardware_status: 布尔或字符串("on"/"off"), PTC硬件实际状态
   * {room}_room_temp: 整数, 面板检测的室内温度
   * {room}_target_temp: 整数, 用户设定的目标温度
   * {room}_inner_mode: 字符串, 内机实际运行模式
   * {room}_shutdown: 布尔或字符串("on"/"off"), 是否发送内机关机指令
   * {room}_ptc_state_data: 对象, 存储在flow中的状态数据
   * 
   * === 输出变量 ===
   * {room}_sync_mode: 字符串, 需同步到内机的运行模式
   * {room}_sync_fan: 字符串, 需同步的风速
   * {room}_ptc_hardware_command: 布尔值, 发送给PTC硬件的命令
   * {room}_ptc_state_data: 对象, 更新后的状态数据
   * 
   * === 房间列表 ===
   * "diningroom", "kitchen", "washroom", "bedroom2", "bedroom3", 
   * "bedroom1", "2faisle", "livingroom", "bedroom1f"
   */

} // end runPTCLinkedControl

/** =========================
 *  7) 生成指令（保持新文件13变量名/行为）
 *  ========================= */

/**
 * 7.1 内机控制指令（对应「生成内机应发数据」）
 *  - 读取 flow：${room}_sync_mode / ${room}_sync_fan / ${room}_adjusted_temp / ${room}_shutdown
 */
function buildIndoorControlActions() {
  const actions = [];
  const map = CFG.INDOOR_CONTROL_ENTITY;

  for (const roomName of Object.keys(map)) {
    const entityId = map[roomName];

    const shutdown = !!flow.get(`${roomName}_shutdown`);
    const syncMode = flow.get(`${roomName}_sync_mode`);
    const syncFan = flow.get(`${roomName}_sync_fan`);
    const adjustedTemp = flow.get(`${roomName}_adjusted_temp`);

    if (shutdown) {
      // ✅ 关机安全：除了关内机，还要确保 PTC 功能/硬件都关掉（避免“风机关了但PTC还在加热”）
      actions.push(makeActionMsg("climate.turn_off", entityId, {}, `indoor.turn_off.${roomName}`));

      // 1) PTC 功能开关（如果房间有）
      if (CFG.PTC_FUNC_ENTITY[roomName]) {
        actions.push(makeActionMsg("switch.turn_off", CFG.PTC_FUNC_ENTITY[roomName], {}, `ptc.func.off.safety.${roomName}`));
      }

      // 2) PTC 硬件开关（如果房间有）
      if (CFG.PTC_HW_ENTITY[roomName]) {
        actions.push(makeActionMsg("switch.turn_off", CFG.PTC_HW_ENTITY[roomName], {}, `ptc.hw.off.safety.${roomName}`));
      }

      // 同时把“硬件命令”写回 flow（让 stage2 的去重逻辑也能看到）
      flow.set(`${roomName}_ptc_hardware_command`, false);
      flow.set(`${roomName}_ptc_operation`, "off");

      continue;
    }

    if (syncMode && syncMode !== "不操作") {
      // comfort 特殊处理（保持新文件13逻辑）
      if (syncMode === "comfort") {
        actions.push(makeActionMsg("climate.set_preset_mode", entityId, { preset_mode: "comfort" }, `indoor.preset.comfort.${roomName}`));
        actions.push(makeActionMsg("climate.set_hvac_mode", entityId, { hvac_mode: "auto" }, `indoor.mode.auto.${roomName}`));
      } else {
        actions.push(makeActionMsg("climate.set_hvac_mode", entityId, { hvac_mode: syncMode }, `indoor.mode.${roomName}`));
      }
    }

    if (syncFan && syncFan !== "不操作") {
      actions.push(makeActionMsg("climate.set_fan_mode", entityId, { fan_mode: syncFan }, `indoor.fan.${roomName}`));
    }

    if (adjustedTemp != null && adjustedTemp !== "不操作") {
      actions.push(makeActionMsg("climate.set_temperature", entityId, { temperature: adjustedTemp }, `indoor.temp.${roomName}`));
    }
  }

  return actions;
}

/**
 * 7.2 PTC 功能指令（对应「生成PTC功能应发数据」）
 *  - 读取 flow：${room}_ptc_operation -> "on"/"off"/"不操作"
 */
function buildPTCFuncActions() {
  const actions = [];
  for (const roomName of Object.keys(CFG.PTC_FUNC_ENTITY)) {
    const entityId = CFG.PTC_FUNC_ENTITY[roomName];
    const op = flow.get(`${roomName}_ptc_operation`);
    if (!op || op === "不操作") continue;

    const action = op === "on" ? "switch.turn_on" : "switch.turn_off";
    actions.push(makeActionMsg(action, entityId, {}, `ptc.func.${op}.${roomName}`));
  }
  return actions;
}

/**
 * 7.3 PTC 硬件指令（对应「生成PTC硬件应发数据」）
 * ------------------------------------------------------------
 * ✅ 这一段是你之前报“关机状态下 PTC 没有安全输出”的核心修复点：
 *
 * 旧版本的问题：
 *  - `${room}_ptc_hardware_command` 在 PTC 联动算法里被写成 boolean(true/false)
 *  - 但发送函数当成字符串 "on"/"off" 来判断：
 *      - true 反而会走到 turn_off
 *      - false 会被 `if (!cmd)` 直接跳过（完全不发 off）
 *
 * 新版本修复：
 *  - 支持 boolean / "on"/"off"/"true"/"false"/1/0
 *  - 关机(shutdown=true) 时强制把 desired 视为 off（安全优先）
 *  - 去重策略：如果 desired 与“上次已发送”相同且(实际状态已一致或未知)，就不重复发
 */
function buildPTCHardwareActions() {
  // ✅ 对齐 file13：「生成PTC硬件应发数据」
  const actions = [];
  for (const roomName of Object.keys(CFG.PTC_HW_ENTITY)) {
    const entityId = CFG.PTC_HW_ENTITY[roomName];

    // 期望：boolean / "on"/"off"/"true"/"false"/undefined
    const raw = flow.get(`${roomName}_ptc_hardware_command`);
    const wantOn = (raw === true || raw === "on" || raw === "true" || raw === 1);

    // 实际：boolean / "on"/"off"/...
    const rawCur = flow.get(`${roomName}_ptc_hardware_status`);
    const curOn = (rawCur === true || rawCur === "on" || rawCur === "true" || rawCur === 1);

    // ✅ 安全：未定义就按 false 处理（宁可多关一次）
    if (wantOn === curOn) continue;

    const action = wantOn ? "switch.turn_on" : "switch.turn_off";
    actions.push(makeActionMsg(action, entityId, {}, `ptc.hw.${wantOn ? "on" : "off"}.${roomName}`));
  }
  return actions;
}

function buildPanelModeOverrideActions() {
  const actions = [];
  for (const roomKey of Object.keys(CFG.ROOM_BY_FLOORNO)) {
    const roomName = CFG.ROOM_BY_FLOORNO[roomKey];
    // kitchen/washroom 没有面板实体，跳过
    if (!roomName || roomName === "kitchen" || roomName === "washroom") continue;

    const overrideMode = flow.get(`${roomName}_override_panel_mode`);
    if (!overrideMode || overrideMode === "不操作") continue;

    // 从 roomKey 反推面板实体ID
    const [floor, roomNo] = roomKey.split("_");
    const panelEntity = `climate.entity_mainlocal_243_204_${floor}_${roomNo}_4_3`;
    actions.push(makeActionMsg("climate.set_hvac_mode", panelEntity, { hvac_mode: overrideMode }, `panel.mode.${overrideMode}.${roomName}`));
  }
  return actions;
}

/**
 * 7.5 面板风速覆盖（对应「生成面板风速应发数据」+「发送面板风速数据」）
 *  - 读取 flow：${room}_override_fan == "auto" 时，下发 0x0C 报文
 *  - 输出：Buffer 列表（OUT3），最终由 link out 40 发到你的 TCP out 流
 */
function buildPanelFanOverrideTcpBuffers() {
  const bufs = [];

  // roomName -> floor/roomNo
  const roomToFloorNo = {};
  for (const k of Object.keys(CFG.ROOM_BY_FLOORNO)) {
    const rn = CFG.ROOM_BY_FLOORNO[k];
    if (!rn || rn === "kitchen" || rn === "washroom") continue;
    const [f, r] = k.split("_");
    roomToFloorNo[rn] = { floor: Number(f), roomNo: Number(r) };
  }

  for (const roomName of Object.keys(roomToFloorNo)) {
    const overrideFan = flow.get(`${roomName}_override_fan`);
    if (overrideFan !== "auto") continue;

    const { floor, roomNo } = roomToFloorNo[roomName];

    // 新文件13：newData = [0x01,0x02,0x0C,0x00,0x02,floor,roomNo] + checksum
    let newData = Buffer.from([0x01, 0x02, 0x0C, 0x00, 0x02, floor, roomNo]);

    let checksum = 0;
    for (let i = 0; i < newData.length; i++) checksum = (checksum + newData[i]) & 0xff;
    newData = Buffer.concat([newData, Buffer.from([checksum])]);

    bufs.push(makeTcpMsg(newData, `panel.fan.auto.${roomName}`));
  }

  return bufs;
}

/**
 * 7.6 新风模式（对应「操作新风模式」）
 *  - 读取 flow：new_ventilation_mode（期望），ventilation_mode_set（已下发记录）
 */
function buildVentilationActionIfNeeded() {
  // ✅ 对齐 file13：「操作新风模式」
  // ventilation_mode_set: "bypass" | "heat" | null
  const mode = flow.get("ventilation_mode_set");
  if (!mode || mode === "不操作") return [];

  const preset_mode_map = {
    bypass: "旁通",
    heat: "热交换",
    auto: "自动",
    heat_exchange: "热交换"
  };

  const preset = preset_mode_map[String(mode)] || String(mode);
  const currentPreset = flow.get("ventilation_preset_mode"); // 例如："旁通"/"热交换"/"自动"

  // 避免重复下发
  if (currentPreset != null && String(currentPreset) === preset) return [];

  const actionMsg = makeActionMsg(
    "fan.set_preset_mode",
    CFG.ENT.ventilation_fan,
    { preset_mode: preset },
    `ventilation.preset.${preset}`
  );

  // 记录一下“我们刚发过什么”，便于排查（不依赖它做逻辑）
  flow.set("ventilation_preset_mode_set", preset);

  return [actionMsg];
}

function buildFanPowerActionIfNeeded() {
  // ✅ 对齐 file13：「操作风扇电源」
  // fan_power_switch_set: boolean（期望）
  // fan_power_switch: boolean（当前）
  const wantOn = !!flow.get("fan_power_switch_set");
  const isOn = !!flow.get("fan_power_switch");

  if (wantOn === isOn) return [];

  const action = wantOn ? "fan.turn_on" : "fan.turn_off";
  return [makeActionMsg(action, CFG.ENT.fan_power, {}, `fan_power.${wantOn ? "on" : "off"}`)];
}

function buildFanSpeedActionIfNeeded() {
  // ✅ 对齐 file13：「操作风扇转速」
  // fan_speed_set: 0~255（期望）
  // fan_speed: 0~255（当前亮度）
  const want = flow.get("fan_speed_set");
  if (want == null || want === "不操作") return [];

  const speed = Number(want);
  if (!isFinite(speed)) return [];

  const cur = Number(flow.get("fan_speed") || 0);
  if (isFinite(cur) && String(cur) === String(speed)) return [];

  // speed==0 时，直接关灯更符合直觉
  if (speed <= 0) {
    return [makeActionMsg("light.turn_off", CFG.ENT.fan_speed_light, {}, "fan_speed.off")];
  }

  return [makeActionMsg("light.turn_on", CFG.ENT.fan_speed_light, { brightness: speed }, `fan_speed.${speed}`)];
}

function buildWaterSprayActionIfNeeded() {
  // ✅ 对齐 file13：「操作喷水器」
  const wantOn = !!flow.get("water_spray_set");

  // 读取 HA 当前状态：喷水器实体 state 是 "on"/"off"
  const curState = String(flow.get("water_spray_status") || "").toLowerCase();
  const isOn = (curState === "on" || curState === "true");

  if (wantOn === isOn) return [];

  const action = wantOn ? "switch.turn_on" : "switch.turn_off";
  return [makeActionMsg(action, CFG.WATER_SPRAY_ENTITY, {}, `water_spray.${wantOn ? "on" : "off"}`)];
}

/** =========================
 *  8) 轮询查询列表
 *  ========================= */
function buildAllQueryMsgs() {
  const ids = new Set();

  // 面板 climate
  for (const eid of CFG.PANEL_CLIMATES) ids.add(eid);

  
  // ✅ 真实内机状态（file13：模式数据写入flow）
  for (const k of Object.keys(CFG.INDOOR_CONTROL_ENTITY)) ids.add(CFG.INDOOR_CONTROL_ENTITY[k]);

// 内机硬件 climate（回风+模式+无面板目标温度）
  for (const eid of CFG.INDOOR_STATUS_CLIMATES) ids.add(eid);

  // PTC
  for (const k of Object.keys(CFG.PTC_FUNC_ENTITY)) ids.add(CFG.PTC_FUNC_ENTITY[k]);
  for (const k of Object.keys(CFG.PTC_HW_ENTITY)) ids.add(CFG.PTC_HW_ENTITY[k]);

  // 其它关键实体
  ids.add(CFG.ENT.outdoor_fin_temp);
  ids.add(CFG.ENT.system_power);
  ids.add(CFG.ENT.ventilation_fan);
  ids.add(CFG.ENT.floor_heating);
  ids.add(CFG.ENT.fan_power);
  ids.add(CFG.ENT.fan_speed_light);
  ids.add(CFG.WATER_SPRAY_ENTITY);

  // 喷水器（file13：switch.zi_shui_qi）
  ids.add(CFG.WATER_SPRAY_ENTITY);

  ids.add(CFG.ENT.device_room_temp_point1);
  ids.add(CFG.ENT.device_room_temp_point2);

  ids.add(CFG.ENT.temp_1f_room);
  ids.add(CFG.ENT.temp_1f_return2);
  ids.add(CFG.ENT.temp_2f_aisle_return2);
  ids.add(CFG.ENT.temp_2f_aisle_return1);

  // 输出为 msg 列表（让 OUT1 一次性吐出多条消息，Delay 节点负责限速）
  const msgs = [];
  for (const eid of ids) msgs.push(makeQueryMsg(eid, "poll"));
  return msgs;
}

/** =========================
 *  9) 状态快照（用于 WebSocket/Debug/持久化）
 *  ========================= */
function buildSnapshot(phase, extra) {
  const rooms = ["livingroom","bedroom1","bedroom2","bedroom3","studyroom","diningroom","bedroom1f","2faisle","kitchen","washroom"];
  const roomState = {};
  for (const r of rooms) {
    roomState[r] = {
      panel_mode: flow.get(`${r}_panel_mode`),
      inner_mode: flow.get(`${r}_inner_mode`),
      fan_mode: flow.get(`${r}_fan_mode`),
      room_temp: flow.get(`${r}_room_temp`),
      return_temp: flow.get(`${r}_return_temp`),
      target_temp: flow.get(`${r}_target_temp`),

      // 控制输出（核心）
      sync_mode: flow.get(`${r}_sync_mode`),
      sync_fan: flow.get(`${r}_sync_fan`),
      adjusted_temp: flow.get(`${r}_adjusted_temp`),
      shutdown: flow.get(`${r}_shutdown`),

      ptc_operation: flow.get(`${r}_ptc_operation`),
      ptc_func_status: flow.get(`${r}_ptc_func_status`),
      ptc_hardware_command: flow.get(`${r}_ptc_hardware_command`),
      ptc_hardware_status: flow.get(`${r}_ptc_hardware_status`),

      override_panel_mode: flow.get(`${r}_override_panel_mode`),
      override_fan: flow.get(`${r}_override_fan`),
    };
  }

  const snap = {
    ts: nowMs(),
    phase,
    outdoor_fin_temp: flow.get("outdoor_fin_temp"),
    device_room_temp: flow.get("device_room_temp"),
    system_power: flow.get("system_power"),
    floor_heating_on: flow.get("floor_heating_on"),
    ventilation_status: flow.get("ventilation_status"),
    ventilation_preset_mode: flow.get("ventilation_preset_mode"),
    ventilation_mode_set: flow.get("ventilation_mode_set"),
    ventilation_preset_mode_set: flow.get("ventilation_preset_mode_set"),
    fan_power_switch: flow.get("fan_power_switch"),
    fan_power_switch_set: flow.get("fan_power_switch_set"),
    fan_speed: flow.get("fan_speed"),
    fan_speed_set: flow.get("fan_speed_set"),
    water_spray_set: flow.get("water_spray_set"),
    rooms: roomState,
  };

  if (extra) snap.extra = extra;
  // ✅ Node-RED 多输出口：OUT4 需要的是“msg对象”，而不是裸对象。
  //    如果直接 return snap，后面的 Debug/WebSocket 节点会看到 msg.payload === undefined。
  return {
    _event: "snapshot",
    _phase: String(phase || ""),
    payload: snap
  };
}

/** =========================
 *  10) 主入口：根据输入消息分发
 *  ========================= */
let outQueries = null;    // OUT1
let outActions = null;    // OUT2
let outTcp = null;        // OUT3
let outSnap = null;       // OUT4
let outPhases = null;     // OUT5

try {
  // ---- 10.1 清空 ----
  if (msg && msg.payload === "reset") {
    // 只清空本流核心变量，避免把你UI/全局配置清掉
    const keys = [
      "outdoor_fin_temp","device_room_temp","device_room_temp_point1","device_room_temp_point2","system_power",
      "floor_heating_on","ventilation_status","ventilation_mode_set","new_ventilation_mode",
      "fan_power_switch","fan_power_switch_set","fan_speed","fan_speed_set",
      "water_spray_set","water_spray_operation",
    ];
    for (const k of keys) flow.set(k, null);

    const rooms = ["livingroom","bedroom1","bedroom2","bedroom3","studyroom","diningroom","bedroom1f","2faisle","kitchen","washroom"];
    for (const r of rooms) {
      const rk = [
        "_panel_mode","_fan_mode","_room_temp","_target_temp","_hvac_action","_panel_updated","_panel_fan_updated",
        "_return_temp","_inner_mode",
        "_sync_mode","_sync_fan","_adjusted_temp","_shutdown",
        "_ptc_operation","_ptc_func_status","_ptc_hardware_command","_ptc_hardware_status",
        "_override_panel_mode","_override_fan",
      ];
      for (const suf of rk) flow.set(`${r}${suf}`, null);
    }

    node.status({ fill: "grey", shape: "dot", text: "🧹reset | cleared" });
    outSnap = buildSnapshot("reset", { note: "cleared" });
    return [null, null, null, outSnap, null];
  }

  // ---- 10.2 面板0x0C风速数据输入（可选）----
  if (msg && (msg._event === "panel_0x0c" || Buffer.isBuffer(msg.payload) || msg.payload instanceof Uint8Array)) {
    handlePanel0x0cPayload(msg.payload);
    return [null, null, null, null, null];
  }

  // ---- 10.3 HA 查询回包 ----
  if (msg && msg._event === "ha_state") {
    handleHaStateResponse(msg);
    return [null, null, null, null, null];
  }

  // ---- 10.4 周期 tick：开始 poll1（阶段由外部 delay 链生成） ----
  const isTick = (msg && (msg.payload === "tick" || msg._event === "tick"));
  if (isTick) {
    node.status({ fill: "grey", shape: "ring", text: "⏱ tick | poll1" });
    outQueries = buildAllQueryMsgs();

    // 重要：本版本不再由 OUT5 输出 phase 消息，而是由「tick 注入 → delay → 回灌」链路生成 stage1/poll2/stage2
    outSnap = buildSnapshot("tick", { note: "poll1 fired" });
    return [outQueries, null, null, outSnap, null];
  }

  // ---- 10.5 阶段消息 ----
  if (msg && msg._event === "phase") {
    const phase = msg._phase;

    if (phase === "poll2") {
      node.status({ fill: "blue", shape: "ring", text: "🔄 poll2 | refresh states" });
      outQueries = buildAllQueryMsgs();
      outSnap = buildSnapshot("poll2", { note: "poll2" });
      return [outQueries, null, null, outSnap, null];
    }

    if (phase === "stage1") {
      node.status({ fill: "yellow", shape: "dot", text: "⚙ stage1 | compute + send" });
      // 先用最新点位更新 device_room_temp
      computeDeviceRoomTemp();

      // 运行主控制
      const mainResult = runMainControlV41();

      // 生成并发送：内机 + PTC功能 + 面板模式 + 新风 + 风扇电源/转速 + 喷雾
      const actions = []
        .concat(buildIndoorControlActions())
        .concat(buildPTCFuncActions())
        .concat(buildPanelModeOverrideActions())
        .concat(buildVentilationActionIfNeeded())
        .concat(buildFanPowerActionIfNeeded())
        .concat(buildFanSpeedActionIfNeeded())
        .concat(buildWaterSprayActionIfNeeded());

      outActions = actions;

      // 面板风速覆盖（TCP Buffer）
      outTcp = buildPanelFanOverrideTcpBuffers();

      outSnap = buildSnapshot("stage1", { mainResult, actionCount: actions.length, tcpCount: (outTcp || []).length });
      return [null, outActions, outTcp, outSnap, null];
    }

    if (phase === "stage2") {
      node.status({ fill: "yellow", shape: "dot", text: "🛡 stage2 | PTC safety sync" });
      // 运行 PTC 联动（它会写 flow：${room}_ptc_hardware_command 等）
      const ptcResult = runPTCLinkedControl();

      // stage2 只发：PTC硬件 + 内机（保持新文件13节奏）
      const actions = []
        .concat(buildPTCHardwareActions())
        .concat(buildIndoorControlActions());

      outActions = actions;

      outSnap = buildSnapshot("stage2", { ptcResult, actionCount: actions.length });
      return [null, outActions, null, outSnap, null];
    }

    // 未知 phase：忽略
    return [null, null, null, null, null];
  }

  // ---- 10.6 兜底：未知输入，不处理 ----
  return [null, null, null, null, null];

} catch (err) {
  node.error(err);
  node.status({ fill: "red", shape: "ring", text: "❌ error | see debug" });
  outSnap = {
    _event: "snapshot",
    _phase: "error",
    payload: {
      ts: nowMs(),
      phase: "error",
      error: String(err && err.message ? err.message : err),
    }
  };
  return [null, null, null, outSnap, null];
}
