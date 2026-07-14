pub fn quote_posix_shell_arg(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn quote_posix_single_quotes() {
        assert_eq!(quote_posix_shell_arg("a'b"), "'a'\\''b'");
    }
}
