// 펫 몸과 모집 표시·이름표 사이의 세로 간격을 물리 픽셀로 계산한다.
pub fn row_stride(pet_size: f64, scale: f64) -> i32 {
    ((pet_size + 80.0) * scale).ceil() as i32
}

// 모집자의 위치를 기준으로 작업영역 안에서 겹치지 않는 참여자 자리를 계산한다.
pub fn position(
    host: (i32, i32),
    horizontal: (i32, i32),
    minimum_y: i32,
    stride_x: i32,
    stride_y: i32,
    index: usize,
) -> Option<(i32, i32)> {
    // 1. 모집자 양쪽의 수용량과 각 행에 들어갈 자리 수를 구한다.
    if index == 0 || horizontal.0 > horizontal.1 || host.1 < minimum_y {
        return None;
    }
    let stride_x = stride_x.max(1);
    let stride_y = stride_y.max(1);
    let left = ((host.0 - horizontal.0).max(0) / stride_x) as usize;
    let right = ((horizontal.1 - host.0).max(0) / stride_x) as usize;
    let columns = left + right + 1;
    let first_row = columns - 1;

    // 2. 첫 행은 모집자를 제외하고, 다음 행은 중앙부터 양쪽으로 배치한다.
    let (row, slot) = if index <= first_row {
        (0, index)
    } else {
        let remaining = index - first_row - 1;
        (1 + remaining / columns, remaining % columns)
    };
    let y = i64::from(host.1) - row as i64 * i64::from(stride_y);
    if y < i64::from(minimum_y) {
        return None;
    }
    if slot == 0 {
        return Some((host.0, y as i32));
    }
    let mut used_left = 0;
    let mut used_right = 0;
    for _ in 0..slot {
        if used_right <= used_left && used_right < right {
            used_right += 1;
        } else if used_left < left {
            used_left += 1;
        } else {
            used_right += 1;
        }
    }
    let offset = if used_right > used_left && used_right <= right {
        used_right as i32
    } else {
        -(used_left as i32)
    };
    Some((host.0 + offset * stride_x, y as i32))
}

#[cfg(test)]
mod tests {
    use super::{position, row_stride};
    use std::collections::HashSet;

    // 전체 높이의 그림과 위쪽 모집 표시 및 아래쪽 이름표 사이에 여유를 둔다.
    #[test]
    fn rows_reserve_space_for_badge_and_nameplate() {
        for size in [80, 160, 240] {
            for scale in [1.0, 2.0] {
                let stride = row_stride(size as f64, scale);
                let upper = position((0, 0), (0, 0), -2000, 1, stride, 1).unwrap();
                let lower_badge_top = -((size + 34) as f64 * scale) as i32;
                let upper_name_bottom = upper.1 + (28.0 * scale) as i32;
                assert!(upper_name_bottom + (16.0 * scale) as i32 <= lower_badge_top);
            }
        }
    }

    // 양쪽 경계와 여러 행에서 지정 간격을 지키고 자리가 없으면 중복 좌표를 반환하지 않는다.
    #[test]
    fn positions_are_distinct_and_spaced() {
        for size in [80, 160, 240] {
            for host_x in [0, 300, 900] {
                let host = (host_x, 0);
                let mut points = vec![host];
                for index in 1..100 {
                    let Some(point) = position(host, (0, 900), -800, 296, size + 40, index) else {
                        break;
                    };
                    points.push(point);
                }
                assert!(points.len() > 3);
                assert_eq!(
                    points.iter().copied().collect::<HashSet<_>>().len(),
                    points.len()
                );
                for (i, a) in points.iter().enumerate() {
                    for b in points.iter().skip(i + 1) {
                        assert!((a.0 - b.0).abs() >= 296 || (a.1 - b.1).abs() >= size + 40);
                    }
                }
                assert!(position(host, (0, 900), -800, 296, size + 40, points.len()).is_none());
            }
        }
    }
}
