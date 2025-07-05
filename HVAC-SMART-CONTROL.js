/****************************************************************************
 * 空调控制系统完整方案 v4.1
 * 修复：喷水器时间控制、温度判断优化、所有时间相关功能
 * 新增：node.status状态显示
 ****************************************************************************/

/************* 系统基础配置 *************/
const SYSTEM = {
    // 执行周期（毫秒）- 控制系统每隔多久运行一次
    execution_period_ms: 15000,  // 15秒
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
    // 执行次数控制参数（基于15秒执行周期）
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
        min_duration_cycles: 4,
        samples_required: 3,
        force_reset_cycles: 12
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
function determineOutdoorStatus() {
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
    let activeRooms = [];

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

/***** 计算室内加权平均温度 *****/
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

        if (active_units.count === 1 && active_units.rooms.includes(room_id)) {
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

    flow.set('ventilation_mode_set', ventilation_mode);

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
