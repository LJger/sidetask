use crate::Result;
use serde::{Deserialize, Serialize};
use serde_json::Value;

pub const HANDLE_SIZE: f64 = 40.0;
pub const EDGES: [&str; 4] = ["right", "left", "bottom", "top"];

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Default)]
pub struct Point {
    pub x: f64,
    pub y: f64,
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Default)]
pub struct Rect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

impl Rect {
    pub fn center(self) -> Point {
        Point {
            x: self.x + self.width / 2.0,
            y: self.y + self.height / 2.0,
        }
    }
    pub fn rounded(self) -> Self {
        Self {
            x: self.x.round(),
            y: self.y.round(),
            width: self.width.round(),
            height: self.height.round(),
        }
    }
    pub fn divided(self, scale: f64) -> Self {
        Self {
            x: self.x / scale,
            y: self.y / scale,
            width: self.width / scale,
            height: self.height / scale,
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Placement {
    pub mode: String,
    pub display_id: Option<Value>,
    pub edge: String,
    pub anchor: f64,
    pub float_center: Point,
}

impl Default for Placement {
    fn default() -> Self {
        Self {
            mode: "docked".into(),
            display_id: None,
            edge: "right".into(),
            anchor: 0.5,
            float_center: Point { x: 0.5, y: 0.5 },
        }
    }
}

impl Placement {
    pub fn validate(&self) -> Result<()> {
        if !["floating", "docked"].contains(&self.mode.as_str())
            || !EDGES.contains(&self.edge.as_str())
            || ![self.anchor, self.float_center.x, self.float_center.y]
                .iter()
                .all(|n| n.is_finite() && (0.0..=1.0).contains(n))
            || self
                .display_id
                .as_ref()
                .is_some_and(|id| !(id.is_string() || id.is_i64() || id.is_u64() || id.is_null()))
        {
            return Err("窗口位置无效。".into());
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Monitor {
    pub id: String,
    pub bounds: Rect,
    pub work_area: Rect,
    pub scale: f64,
    pub primary: bool,
}

pub fn clamp(n: f64, min: f64, max: f64) -> f64 {
    n.max(min).min(max.max(min))
}

pub fn display_for_bounds(displays: &[Monitor], bounds: Rect, preferred: &str) -> usize {
    let center = bounds.center();
    let mut best: Option<(usize, f64, f64)> = None;
    for (index, display) in displays.iter().enumerate() {
        let area = display.bounds;
        let overlap = ((bounds.x + bounds.width).min(area.x + area.width) - bounds.x.max(area.x))
            .max(0.0)
            * ((bounds.y + bounds.height).min(area.y + area.height) - bounds.y.max(area.y))
                .max(0.0);
        let distance = (area.x - center.x)
            .max(0.0)
            .max(center.x - area.x - area.width)
            .hypot(
                (area.y - center.y)
                    .max(0.0)
                    .max(center.y - area.y - area.height),
            );
        if best.is_none_or(|(_, old_overlap, old_distance)| {
            overlap > old_overlap
                || (overlap == old_overlap
                    && (distance < old_distance
                        || (distance == old_distance && display.id == preferred)))
        }) {
            best = Some((index, overlap, distance));
        }
    }
    best.map(|b| b.0).unwrap_or(0)
}

pub fn floating(area: Rect, bounds: Rect, previous: &Placement) -> Placement {
    Placement {
        mode: "floating".into(),
        float_center: Point {
            x: clamp((bounds.center().x - area.x) / area.width, 0.0, 1.0),
            y: clamp((bounds.center().y - area.y) / area.height, 0.0, 1.0),
        },
        ..previous.clone()
    }
}

pub fn nearest_dock(area: Rect, bounds: Rect, previous: &Placement) -> Placement {
    let distances = [
        (area.x + area.width - bounds.x - bounds.width).abs(),
        (bounds.x - area.x).abs(),
        (area.y + area.height - bounds.y - bounds.height).abs(),
        (bounds.y - area.y).abs(),
    ];
    let minimum = distances.into_iter().fold(f64::INFINITY, f64::min);
    let candidates: Vec<&str> = EDGES
        .iter()
        .zip(distances)
        .filter(|(_, distance)| (*distance - minimum).abs() < 0.5)
        .map(|(edge, _)| *edge)
        .collect();
    let edge = if candidates.contains(&previous.edge.as_str()) {
        previous.edge.clone()
    } else {
        candidates[0].into()
    };
    let anchor = if ["left", "right"].contains(&edge.as_str()) {
        (bounds.center().y - area.y) / area.height
    } else {
        (bounds.center().x - area.x) / area.width
    };
    Placement {
        mode: "docked".into(),
        edge,
        anchor: clamp(anchor, 0.0, 1.0),
        ..floating(area, bounds, previous)
    }
}

#[derive(Clone, Copy, Debug)]
pub struct Layout {
    pub full: Rect,
    pub handle: Rect,
    pub offset: Point,
    pub shift: Point,
}

impl Layout {
    pub fn handle_region(self) -> Rect {
        Rect {
            x: self.handle.x - self.full.x,
            y: self.handle.y - self.full.y,
            width: self.handle.width,
            height: self.handle.height,
        }
        .rounded()
    }

    // Keep the handle attached to its viewport while Windows moves the host
    // or scales it on another monitor. Docking is recalculated on release.
    pub fn with_native_bounds(self, full: Rect) -> Self {
        let x_scale = full.width / self.full.width;
        let y_scale = full.height / self.full.height;
        Self {
            full,
            handle: Rect {
                x: full.x + (self.handle.x - self.full.x) * x_scale,
                y: full.y + (self.handle.y - self.full.y) * y_scale,
                width: self.handle.width * x_scale,
                height: self.handle.height * y_scale,
            }
            .rounded(),
            offset: Point {
                x: self.offset.x * x_scale,
                y: self.offset.y * y_scale,
            },
            shift: Point {
                x: self.shift.x * x_scale,
                y: self.shift.y * y_scale,
            },
        }
    }
}

pub fn layout(
    monitor: &Monitor,
    placement: &Placement,
    view: &str,
    floating_bounds: Option<Rect>,
) -> Layout {
    let area = monitor.work_area;
    let scale = monitor.scale;
    let vertical = ["left", "right"].contains(&placement.edge.as_str());
    let edge = placement.edge.as_str();
    let width = ((if ["week", "month"].contains(&view) {
        1120.0
    } else {
        420.0
    }) * scale)
        .min(area.width)
        .round();
    let margin = (16.0 * scale).min((area.height / 10.0).floor());
    let height = (850.0 * scale).min(area.height - margin * 2.0).round();
    let mut handle = Rect {
        width: (HANDLE_SIZE * scale).min(area.width),
        height: (HANDLE_SIZE * scale).min(area.height),
        ..Rect::default()
    };
    handle.x = if vertical {
        if edge == "left" {
            area.x
        } else {
            area.x + area.width - handle.width
        }
    } else {
        clamp(
            area.x + placement.anchor * area.width - handle.width / 2.0,
            area.x,
            area.x + area.width - handle.width,
        )
    };
    handle.y = if vertical {
        clamp(
            area.y + placement.anchor * area.height - handle.height / 2.0,
            area.y,
            area.y + area.height - handle.height,
        )
    } else if edge == "top" {
        area.y
    } else {
        area.y + area.height - handle.height
    };
    handle = handle.rounded();
    let mut full = Rect {
        width,
        height,
        x: area.x,
        y: area.y,
    };
    if placement.mode == "floating" {
        full.x = clamp(
            area.x + placement.float_center.x * area.width - width / 2.0,
            area.x,
            area.x + area.width - width,
        );
        full.y = clamp(
            area.y + placement.float_center.y * area.height - height / 2.0,
            area.y,
            area.y + area.height - height,
        );
        if let Some(bounds) = floating_bounds {
            full = bounds;
        }
    } else if vertical {
        full.x = if edge == "left" {
            area.x
        } else {
            area.x + area.width - width
        };
        full.y = clamp(
            handle.center().y - height / 2.0,
            area.y,
            area.y + area.height - height,
        );
    } else {
        full.x = clamp(
            handle.center().x - width / 2.0,
            area.x,
            area.x + area.width - width,
        );
        full.y = if edge == "top" {
            area.y
        } else {
            area.y + area.height - height
        };
    }
    Layout {
        full: full.rounded(),
        handle: handle.rounded(),
        shift: Point {
            x: if vertical {
                (if edge == "left" { -1.0 } else { 1.0 }) * (full.width - handle.width)
            } else {
                0.0
            },
            y: if vertical {
                0.0
            } else {
                (if edge == "top" { -1.0 } else { 1.0 }) * (full.height - handle.height)
            },
        },
        offset: Point {
            x: if vertical {
                if edge == "right" {
                    0.0
                } else {
                    full.width - handle.width
                }
            } else {
                handle.x - full.x
            },
            y: if vertical {
                handle.y - full.y
            } else if edge == "bottom" {
                0.0
            } else {
                full.height - handle.height
            },
        },
    }
}
