#![cfg(target_os = "linux")]

use gtk::glib::variant::ToVariant;

// 실제 GLib FFI의 양방향 문자열 반복자가 빈 문자열과 UTF-8을 안전하게 빌리는지 확인한다.
#[test]
fn variant_str_iter_preserves_borrowed_values_in_both_directions() {
    // 1. 최적화로 입력이 사라지지 않도록 실제 문자열 배열을 Variant에 전달한다.
    let expected = ["", "alpha", "한글", "🦀", "omega", "last"];
    let value = std::hint::black_box(expected.to_variant());
    let mut iterator = value.array_iter_str().unwrap();

    // 2. 취약점의 공통 FFI 경로를 사용하는 앞뒤 조회와 건너뛰기를 모두 확인한다.
    assert_eq!(iterator.next(), Some(""));
    assert_eq!(iterator.next_back(), Some("last"));
    assert_eq!(iterator.nth(1), Some("한글"));
    assert_eq!(iterator.nth_back(1), Some("🦀"));
    assert_eq!(iterator.len(), 0);
    assert_eq!(iterator.next(), None);
    assert_eq!(iterator.next_back(), None);
}

// 마지막 원소와 빈 배열의 경계에서도 수정된 FFI 경로가 안전한 값을 반환하는지 확인한다.
#[test]
fn variant_str_iter_handles_last_and_empty_arrays() {
    // 1. 마지막 조회가 최적화 빌드에서도 실제 문자열을 반환하는지 확인한다.
    let value = std::hint::black_box(["first", "한글", "last"].to_variant());
    assert_eq!(value.array_iter_str().unwrap().last(), Some("last"));
    assert_eq!(
        value.array_iter_str().unwrap().collect::<Vec<_>>(),
        ["first", "한글", "last"]
    );

    // 2. 원소가 없는 경우 FFI를 잘못 호출하지 않고 반복을 끝내는지 확인한다.
    let empty = Vec::<String>::new().to_variant();
    assert_eq!(empty.array_iter_str().unwrap().next(), None);
    assert_eq!(empty.array_iter_str().unwrap().next_back(), None);
    assert_eq!(empty.array_iter_str().unwrap().last(), None);
}
