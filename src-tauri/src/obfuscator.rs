const XOR_KEY: u8 = 0x7B;

const ENCODED_BASE_URL: &[u8] = &[
    0x13, 0x0F, 0x0F, 0x0B, 0x41, 0x54, 0x54, 0x13, 0x1F, 0x13, 0x0E, 0x19, 0x55, 0x0F,
    0x13, 0x1E, 0x0D, 0x14, 0x17, 0x1E, 0x18, 0x12, 0x0F, 0x14, 0x09, 0x55, 0x0A, 0x01,
    0x01, 0x55, 0x12, 0x14,
];

const ENCODED_MOVIE_PATH: &[u8] = &[
    0x54, 0x08, 0x0F, 0x09, 0x1E, 0x1A, 0x16, 0x54, 0x16, 0x14, 0x0D, 0x12, 0x1E, 0x54,
];

const ENCODED_SERIES_PATH: &[u8] = &[
    0x54, 0x08, 0x0F, 0x09, 0x1E, 0x1A, 0x16, 0x54, 0x08, 0x1E, 0x09, 0x12, 0x1E, 0x08, 0x54,
];

const ENCODED_JSON_EXT: &[u8] = &[0x55, 0x11, 0x08, 0x14, 0x15];

fn decode(encoded: &[u8]) -> String {
    encoded.iter().map(|&b| (b ^ XOR_KEY) as char).collect()
}

pub fn base_url() -> String {
    decode(ENCODED_BASE_URL)
}

pub fn movie_stream_url(imdb_id: &str) -> String {
    format!(
        "{}{}{}{}",
        decode(ENCODED_BASE_URL),
        decode(ENCODED_MOVIE_PATH),
        imdb_id,
        decode(ENCODED_JSON_EXT),
    )
}

pub fn series_stream_url(imdb_id: &str, season: i32, episode: i32) -> String {
    format!(
        "{}{}{}:{}:{}{}",
        decode(ENCODED_BASE_URL),
        decode(ENCODED_SERIES_PATH),
        imdb_id,
        season,
        episode,
        decode(ENCODED_JSON_EXT),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn encode(input: &str) -> Vec<u8> {
        input.bytes().map(|b| b ^ XOR_KEY).collect()
    }

    #[test]
    fn test_decode_roundtrip() {
        let test = "hello.world";
        let enc = encode(test);
        assert_eq!(decode(&enc), test);
    }

    #[test]
    fn test_base_url() {
        let url = base_url();
        assert!(url.starts_with("http"), "URL should start with http, got: {}", url);
        assert!(url.len() > 10);
    }

    #[test]
    fn test_movie_url() {
        let url = movie_stream_url("tt0111161");
        assert!(url.contains("tt0111161"), "URL should contain IMDB ID");
        assert!(url.ends_with(".json"), "Movie URL must end with .json, got: {}", url);
    }

    #[test]
    fn test_series_url() {
        let url = series_stream_url("tt0944947", 1, 1);
        assert!(url.contains("tt0944947"), "URL should contain IMDB ID");
        assert!(url.contains("1:1"), "URL should contain season:episode");
        assert!(url.ends_with(".json"), "Series URL must end with .json");
    }

    #[test]
    fn test_movie_url_format() {
        let url = movie_stream_url("tt0111161");
        assert!(url.starts_with("http"), "Should start with http");
        assert!(url.contains("/stream/movie/"), "Should contain /stream/movie/");
        assert!(url.contains("tt0111161"), "Should contain IMDB ID");
        assert!(url.ends_with(".json"), "Should end with .json");
    }

    #[test]
    fn test_series_url_format() {
        let url = series_stream_url("tt0944947", 1, 1);
        assert!(url.starts_with("http"), "Should start with http");
        assert!(url.contains("/stream/series/"), "Should contain /stream/series/");
        assert!(url.contains("tt0944947"), "Should contain IMDB ID");
        assert!(url.contains(":1:1"), "Should contain :season:episode");
        assert!(url.ends_with(".json"), "Should end with .json");
    }
}
