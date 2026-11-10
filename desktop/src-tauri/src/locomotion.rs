use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

#[derive(Clone)]
struct Observation {
    position: (i32, i32),
    scale: f64,
    at: Instant,
}

#[derive(Clone)]
pub struct MotionState {
    pub velocity_x: f64,
    pub velocity_y: f64,
    fraction_x: f64,
    fraction_y: f64,
    pub distance: f64,
    pub actual_direction: Option<i32>,
    pub observation_epoch: u64,
    last_observation: Option<Observation>,
    pending_layout: Option<((i32, i32), Instant)>,
    workspace: Option<(i32, i32, u32, u32)>,
    last_report: Instant,
    reported: Option<(bool, i32, bool)>,
}

impl MotionState {
    // 창별 속도·소수 이동량·보행 누적 거리를 초기화한다.
    pub fn new() -> Self {
        Self {
            velocity_x: 0.0,
            velocity_y: 0.0,
            fraction_x: 0.0,
            fraction_y: 0.0,
            distance: 0.0,
            actual_direction: None,
            observation_epoch: 0,
            last_observation: None,
            pending_layout: None,
            workspace: None,
            last_report: Instant::now(),
            reported: None,
        }
    }

    // 직접 조작이나 화면 보정에서는 관성을 없애고 보행 거리는 추가하지 않는다.
    pub fn stop(&mut self) {
        self.velocity_x = 0.0;
        self.velocity_y = 0.0;
        self.fraction_x = 0.0;
        self.fraction_y = 0.0;
    }

    // 직접 조작과 화면 보정에서 누적 거리는 보존하고 실제 관측 기준만 초기화한다.
    pub fn reset_observation(&mut self) {
        self.last_observation = None;
        self.pending_layout = None;
        self.actual_direction = None;
        self.reported = None;
        self.observation_epoch = self.observation_epoch.wrapping_add(1);
    }

    // 비동기 창 배치가 실제 관측될 때까지 보행과 거리 누적을 잠시 보류한다.
    pub fn reset_for_layout(&mut self, position: (i32, i32)) {
        self.stop();
        self.reset_observation();
        self.pending_layout = Some((position, Instant::now() + Duration::from_secs(1)));
    }

    // 레이아웃 요청이 아직 관측되지 않았다면 다른 이동 요청을 겹쳐 보내지 않는다.
    pub fn awaiting_layout(&self) -> bool {
        self.pending_layout.is_some()
    }

    // 같은 배율의 모니터 교체나 작업영역 재배치도 보행 거리에서 제외한다.
    pub fn observe_workspace(&mut self, bounds: (i32, i32, u32, u32)) -> bool {
        let changed = self.workspace.is_some_and(|previous| previous != bounds);
        self.workspace = Some(bounds);
        if changed {
            self.stop();
            self.reset_observation();
        }
        changed
    }

    // 경과 시간과 가감속으로 논리 속도를 적분하고 물리 픽셀의 나머지를 보존한다.
    pub fn step(
        &mut self,
        delta: (f64, f64),
        maximum_speed: f64,
        seconds: f64,
        scale: f64,
    ) -> (i32, i32) {
        // 1. 목표까지의 거리와 제동 거리에 맞춰 원하는 속도를 정한다.
        let length = delta.0.hypot(delta.1);
        let braking = 180.0;
        let speed = maximum_speed.min((2.0 * braking * length).sqrt());
        let desired = if length > 0.01 {
            (delta.0 / length * speed, delta.1 / length * speed)
        } else {
            (0.0, 0.0)
        };
        let previous = (self.velocity_x, self.velocity_y);
        let adjustment = (desired.0 - previous.0, desired.1 - previous.1);
        let amount = adjustment.0.hypot(adjustment.1);
        let acceleration = if speed < previous.0.hypot(previous.1) {
            braking
        } else {
            110.0
        };
        let ratio = if amount > 0.0 {
            (acceleration * seconds / amount).min(1.0)
        } else {
            0.0
        };
        self.velocity_x += adjustment.0 * ratio;
        self.velocity_y += adjustment.1 * ratio;

        // 2. 평균 속도로 이동하되 정수 창 좌표 아래의 이동량은 다음 프레임에 합친다.
        self.fraction_x += (previous.0 + self.velocity_x) * 0.5 * seconds * scale;
        self.fraction_y += (previous.1 + self.velocity_y) * 0.5 * seconds * scale;
        let result = (
            self.fraction_x.round() as i32,
            self.fraction_y.round() as i32,
        );
        self.fraction_x -= result.0 as f64;
        self.fraction_y -= result.1 as f64;
        result
    }

    // 실제 창 이동에서만 논리 수평 거리를 누적하고 이동 중 표본과 저빈도 정지 상태를 만든다.
    #[expect(
        clippy::too_many_arguments,
        reason = "한 프레임의 실제 좌표·배율·시간을 함께 계산한다"
    )]
    pub fn sample(
        &mut self,
        previous: (i32, i32),
        current: (i32, i32),
        scale: f64,
        seconds: f64,
        direction: i32,
        pair: bool,
        count_distance: bool,
    ) -> Option<serde_json::Value> {
        // 1. 연속한 실제 관측끼리 비교해 창 관리자가 다음 프레임에 적용한 이동도 회수한다.
        let now = Instant::now();
        let baseline = self.last_observation.take().unwrap_or(Observation {
            position: previous,
            scale,
            at: now
                .checked_sub(Duration::from_secs_f64(seconds.max(0.001)))
                .unwrap_or(now),
        });
        let observed_seconds = now.duration_since(baseline.at).as_secs_f64().max(0.001);
        let layout_blocked = if let Some((expected, deadline)) = self.pending_layout {
            if current == expected || now >= deadline {
                self.pending_layout = None;
            }
            true
        } else {
            false
        };
        let valid = count_distance && !layout_blocked && (baseline.scale - scale).abs() < 0.001;
        let delta_x = if valid {
            (current.0 - baseline.position.0) as f64 / scale
        } else {
            0.0
        };
        let delta_y = if valid {
            (current.1 - baseline.position.1) as f64 / scale
        } else {
            0.0
        };
        self.last_observation = Some(Observation {
            position: current,
            scale,
            at: now,
        });
        self.actual_direction = if delta_x.abs() > 0.0 {
            Some(if delta_x < 0.0 { -1 } else { 1 })
        } else {
            None
        };
        let actual_direction = self.actual_direction.unwrap_or_else(|| {
            self.reported
                .map(|(_, observed_direction, _)| observed_direction)
                .unwrap_or(direction)
        });
        let horizontal = delta_x.abs();
        self.distance += horizontal;

        // 2. 요청 속도와 실제 속도를 구분하며 관측 거리가 없으면 보행 위상을 증가시키지 않는다.
        let requested_speed = self.velocity_x.hypot(self.velocity_y);
        let walking = valid && (delta_x != 0.0 || delta_y != 0.0 || requested_speed > 0.5);
        let state = (walking, actual_direction, pair);
        if self.reported == Some(state)
            && !walking
            && now.duration_since(self.last_report) < Duration::from_secs(2)
        {
            return None;
        }
        self.reported = Some(state);
        self.last_report = now;
        Some(
            serde_json::json!({ "walking": walking, "direction": actual_direction, "distance": self.distance, "speed": horizontal / observed_seconds, "requestedSpeed": requested_speed, "requestedVelocityX": self.velocity_x, "requestedVelocityY": self.velocity_y, "x": current.0 as f64 / scale, "y": current.1 as f64 / scale, "scale": scale, "timestamp": unix_millis(), "pair": pair }),
        )
    }
}

// 네이티브와 웹의 반응 시작 시계를 맞추는 Unix 밀리초를 반환한다.
pub fn unix_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}
