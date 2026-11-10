/// Physical work-area placement, with margins and explicit requested size.
/// Works with negative monitor origins and fractional HiDPI scaling.
pub fn launcher_bounds(
    x: i32,
    y: i32,
    width: u32,
    height: u32,
    scale: f64,
    logical_height: f64,
) -> (i32, i32, u32, u32) {
    let margin = (8.0 * scale).round() as i64;
    let aw = i64::from(width).max(1);
    let ah = i64::from(height).max(1);
    let w = (600.0 * scale).round().max(1.0) as i64;
    let h = (logical_height.clamp(104.0, 480.0) * scale)
        .round()
        .max(1.0) as i64;
    let w = w.min((aw - margin * 2).max(1));
    let h = h.min((ah - margin * 2).max(1));
    let left = i64::from(x) + (aw - w) / 2;
    let top = i64::from(y) + (ah - h) / 3;
    (left as i32, top as i32, w as u32, h as u32)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn normal_and_resized_windows_stay_inside_work_area() {
        for scale in [1.0, 1.25, 2.0] {
            for h in [104.0, 200.0, 480.0] {
                for (x, y, w, h_area) in [
                    (0, 0, 1920, 1063),
                    (-1920, -200, 1920, 1080),
                    (0, 0, 320, 240),
                ] {
                    let (left, top, width, height) = launcher_bounds(x, y, w, h_area, scale, h);
                    assert!(left >= x && top >= y);
                    assert!(i64::from(left) + i64::from(width) <= i64::from(x) + i64::from(w));
                    assert!(i64::from(top) + i64::from(height) <= i64::from(y) + i64::from(h_area));
                }
            }
        }
    }
}
