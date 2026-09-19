use crate::{geometry::*, Result};
use serde_json::{json, Value};
use std::time::{Duration, Instant};

struct Travel {
    source: Rect,
    target: Rect,
    start: Instant,
    next_frame: Instant,
}

pub struct WindowController {
    pub placement: Placement,
    pub view: String,
    pub monitors: Vec<Monitor>,
    pub monitor: usize,
    pub bounds: Rect,
    pub expanded: bool,
    pub surface_expanded: bool,
    pub phase: &'static str,
    pub stage: &'static str,
    pub transition_id: u64,
    pub dragging: bool,
    pub focused: bool,
    pub protected: bool,
    pub auto_collapse: bool,
    pub reduced_motion: bool,
    automatic: bool,
    focus_restored: bool,
    travel: Option<Travel>,
    deadline: Option<Instant>,
    drag_deadline: Option<Instant>,
    drag_layout: Option<Layout>,
}

impl WindowController {
    pub fn new(
        mut placement: Placement,
        view: String,
        monitors: Vec<Monitor>,
        expanded: bool,
    ) -> Self {
        assert!(!monitors.is_empty());
        let monitor = monitors
            .iter()
            .position(|m| {
                placement.display_id.as_ref().and_then(Value::as_str) == Some(m.id.as_str())
            })
            .unwrap_or_else(|| monitors.iter().position(|m| m.primary).unwrap_or(0));
        placement.display_id = Some(json!(monitors[monitor].id));
        if !expanded && placement.mode == "floating" {
            placement = nearest_dock(
                monitors[monitor].work_area,
                layout(&monitors[monitor], &placement, &view, None).full,
                &placement,
            );
        }
        let geometry = layout(&monitors[monitor], &placement, &view, None);
        Self {
            placement,
            view,
            monitors,
            monitor,
            bounds: if expanded {
                geometry.full
            } else {
                geometry.handle
            },
            expanded,
            surface_expanded: expanded,
            phase: if expanded { "expanded" } else { "collapsed" },
            stage: "settled",
            transition_id: 0,
            dragging: false,
            focused: expanded,
            protected: false,
            auto_collapse: true,
            reduced_motion: false,
            automatic: false,
            focus_restored: false,
            travel: None,
            deadline: None,
            drag_deadline: None,
            drag_layout: None,
        }
    }

    pub fn current_monitor(&self) -> &Monitor {
        &self.monitors[self.monitor]
    }
    pub fn layout(&self) -> Layout {
        self.drag_layout.unwrap_or_else(|| {
            layout(
                self.current_monitor(),
                &self.placement,
                &self.view,
                (self.placement.mode == "floating").then_some(self.bounds),
            )
        })
    }
    // The visible bounds can be a 40-DIP handle while the native WebView2
    // surface keeps its full size. Clipping preserves its already drawn pixels.
    pub fn native_bounds(&self) -> Rect {
        if self.surface_expanded {
            self.bounds
        } else {
            self.layout().full
        }
    }
    pub fn native_region(&self) -> Option<Rect> {
        (!self.surface_expanded).then(|| self.layout().handle_region())
    }
    pub fn settled(&self) -> bool {
        self.stage == "settled" && self.travel.is_none() && !self.dragging
    }
    pub fn animating(&self) -> bool {
        self.travel.is_some() || self.stage != "settled"
    }
    pub fn needs_tick(&self) -> bool {
        self.animating() || self.drag_deadline.is_some()
    }

    pub fn snapshot(&self) -> Value {
        let geometry = self.layout();
        let scale = self.current_monitor().scale;
        let full = geometry.full.divided(scale);
        let handle = geometry.handle.divided(scale);
        json!({
            "expanded": self.expanded, "surfaceExpanded": self.surface_expanded,
            "phase": self.phase, "stage": self.stage, "transitionId": self.transition_id,
            "dragging": self.dragging, "docking": self.travel.is_some(),
            "focusRestored": self.focus_restored && self.stage != "settled",
            "dockSide": self.placement.edge, "placementMode": self.placement.mode,
            "panelSize": { "width": full.width, "height": full.height },
            "fullBounds": full, "handleBounds": handle,
            "handleSize": { "width": handle.width, "height": handle.height },
            "handleOffset": { "x": geometry.offset.x / scale, "y": geometry.offset.y / scale },
            "shift": { "x": geometry.shift.x / scale, "y": geometry.shift.y / scale },
            "bounds": self.bounds.divided(scale), "nativeBounds": self.bounds, "scaleFactor": scale,
            "hostBounds": self.native_bounds(), "hostRegion": self.native_region(),
            "monitor": self.current_monitor()
        })
    }

    fn request(&mut self, expanded: bool, now: Instant) {
        if self.expanded == expanded {
            return;
        }
        self.expanded = expanded;
        self.transition_id += 1;
        self.phase = if expanded { "expanding" } else { "collapsing" };
        self.stage = if expanded && !self.surface_expanded {
            "prepare"
        } else {
            "animate"
        };
        self.deadline = Some(now + Duration::from_millis(800));
    }

    pub fn expand(&mut self, now: Instant) {
        self.automatic = false;
        self.focus_restored = false;
        if self.travel.take().is_some() {
            self.placement = floating(
                self.current_monitor().work_area,
                self.bounds,
                &self.placement,
            );
            self.expanded = true;
            self.refresh();
        } else {
            self.request(true, now);
        }
    }

    pub fn collapse(&mut self, automatic: bool, now: Instant) {
        if self.dragging || self.travel.is_some() || !self.expanded {
            return;
        }
        if automatic && (self.focused || self.protected || !self.auto_collapse) {
            return;
        }
        self.automatic = automatic;
        self.focus_restored = false;
        if self.placement.mode == "floating" {
            let source = self.bounds;
            self.placement =
                nearest_dock(self.current_monitor().work_area, source, &self.placement);
            let target = self.layout().full;
            self.travel = Some(Travel {
                source,
                target,
                start: now,
                next_frame: now,
            });
            self.tick(now);
        } else {
            self.request(false, now);
        }
    }

    pub fn toggle(&mut self, now: Instant) {
        if self.travel.is_some() || !self.expanded {
            self.expand(now);
        } else {
            self.collapse(false, now);
        }
    }

    pub fn ready(&mut self, id: u64) {
        if id != self.transition_id || self.stage != "prepare" {
            return;
        }
        self.surface_expanded = true;
        self.bounds = self.layout().full;
        self.stage = "animate";
    }

    pub fn finish(&mut self, id: u64) {
        if id != self.transition_id || self.stage != "animate" {
            return;
        }
        self.settle();
    }

    fn settle(&mut self) {
        self.surface_expanded = self.expanded;
        let geometry = self.layout();
        self.bounds = if self.expanded {
            geometry.full
        } else {
            geometry.handle
        };
        self.phase = if self.expanded {
            "expanded"
        } else {
            "collapsed"
        };
        self.stage = "settled";
        self.deadline = None;
        self.automatic = false;
        self.focus_restored = false;
    }

    pub fn tick(&mut self, now: Instant) {
        // A successful native drag call only queues the OS move loop. If the
        // pointer was released before it starts, WM_EXITSIZEMOVE may never come.
        if self.drag_deadline.is_some_and(|deadline| now >= deadline) {
            self.end_drag(self.bounds, now);
        }
        if let Some(travel) = &mut self.travel {
            if now >= travel.next_frame {
                travel.next_frame = now + Duration::from_millis(16);
                let progress = if self.reduced_motion {
                    1.0
                } else {
                    (now.duration_since(travel.start).as_secs_f64() / 0.160).min(1.0)
                };
                let eased = 1.0 - (1.0 - progress).powi(3);
                self.bounds = Rect {
                    x: travel.source.x + (travel.target.x - travel.source.x) * eased,
                    y: travel.source.y + (travel.target.y - travel.source.y) * eased,
                    ..travel.target
                }
                .rounded();
                if progress >= 1.0 {
                    self.travel = None;
                    self.request(false, now);
                }
            }
        }
        if self.deadline.is_some_and(|deadline| now >= deadline) {
            self.settle();
        }
    }

    pub fn focus(&mut self, focused: bool, now: Instant) {
        self.focused = focused;
        if focused && self.automatic && self.animating() {
            self.expand(now);
            self.focus_restored = true;
        } else if !focused {
            self.collapse(true, now);
        }
    }

    pub fn protect(&mut self, active: bool, now: Instant) {
        self.protected = active;
        if active && self.automatic && self.animating() {
            self.expand(now);
        } else if !active {
            self.collapse(true, now);
        }
    }

    pub fn start_drag(&mut self) -> Result<()> {
        if self.dragging && self.drag_deadline.take().is_some() {
            return Ok(());
        }
        if !self.settled() {
            return Err("请稍候，窗口正在展开或收起。".into());
        }
        self.drag_layout = (!self.expanded).then(|| self.layout());
        self.dragging = true;
        self.automatic = false;
        self.focus_restored = false;
        Ok(())
    }

    pub fn request_drag(&mut self, now: Instant) -> Result<()> {
        if !self.settled() {
            return Err("请稍候，窗口正在展开或收起。".into());
        }
        self.start_drag()?;
        self.drag_deadline = Some(now + Duration::from_millis(500));
        Ok(())
    }

    pub fn moved(&mut self, bounds: Rect) {
        if !self.dragging {
            return;
        }
        self.monitor = display_for_bounds(&self.monitors, bounds, &self.current_monitor().id);
        self.placement.display_id = Some(json!(self.current_monitor().id));
        self.bounds = bounds;
        if self.expanded {
            self.placement = floating(self.current_monitor().work_area, bounds, &self.placement);
        }
    }

    pub fn moved_native(&mut self, bounds: Rect) {
        if !self.dragging {
            return;
        }
        let visible = if self.expanded {
            bounds
        } else {
            let geometry = self.layout().with_native_bounds(bounds);
            self.drag_layout = Some(geometry);
            geometry.handle
        };
        self.moved(visible);
    }

    pub fn end_native_drag(&mut self, bounds: Rect, now: Instant) {
        self.moved_native(bounds);
        self.end_drag(self.bounds, now);
    }

    pub fn end_drag(&mut self, bounds: Rect, now: Instant) {
        self.drag_deadline = None;
        if !self.dragging {
            return;
        }
        self.moved(bounds);
        self.dragging = false;
        self.drag_layout = None;
        if !self.expanded {
            self.placement =
                nearest_dock(self.current_monitor().work_area, bounds, &self.placement);
            self.bounds = self.layout().handle;
        }
        self.collapse(true, now);
    }

    pub fn refresh(&mut self) {
        self.travel = None;
        self.deadline = None;
        self.drag_layout = None;
        self.focus_restored = false;
        self.transition_id += 1;
        self.surface_expanded = self.expanded;
        self.stage = "settled";
        self.phase = if self.expanded {
            "expanded"
        } else {
            "collapsed"
        };
        let geometry = layout(self.current_monitor(), &self.placement, &self.view, None);
        self.bounds = if self.expanded {
            geometry.full
        } else {
            geometry.handle
        };
    }

    pub fn set_view(&mut self, view: &str) -> Result<()> {
        if !["day", "week", "month", "list"].contains(&view) {
            return Err("窗口布局无效。".into());
        }
        if self.view != view {
            self.view = view.into();
            self.refresh();
        }
        Ok(())
    }

    pub fn relocate(&mut self, mut placement: Placement) {
        self.monitor = self
            .monitors
            .iter()
            .position(|m| {
                placement.display_id.as_ref().and_then(Value::as_str) == Some(m.id.as_str())
            })
            .unwrap_or_else(|| self.monitors.iter().position(|m| m.primary).unwrap_or(0));
        placement.display_id = Some(json!(self.current_monitor().id));
        self.placement = placement;
        self.refresh();
    }

    pub fn update_monitors(&mut self, monitors: Vec<Monitor>) {
        if monitors.is_empty() || self.monitors == monitors {
            return;
        }
        self.monitors = monitors;
        self.relocate(self.placement.clone());
    }

    pub fn at_cursor(&mut self, point: Point) {
        let index = display_for_bounds(
            &self.monitors,
            Rect {
                x: point.x,
                y: point.y,
                width: 1.0,
                height: 1.0,
            },
            &self.current_monitor().id,
        );
        if index != self.monitor {
            let mut placement = self.placement.clone();
            placement.display_id = Some(json!(self.monitors[index].id));
            self.relocate(placement);
        }
    }
}
