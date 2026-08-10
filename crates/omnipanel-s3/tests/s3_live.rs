//! 集成测试：对本地 mock S3（http://127.0.0.1:19000/test-bucket）做真实链路验证。
//!
//! 前置：`python3 /tmp/mock_s3.py 19000`（path-style + 不验签）。
//! 运行：`cargo test -p omnipanel-s3 --test s3_live -- --ignored --nocapture`

use omnipanel_s3::{S3Client, S3Config};

fn cfg() -> S3Config {
    S3Config {
        bucket: "test-bucket".to_string(),
        provider: "aws".to_string(),
        region: "us-east-1".to_string(),
        endpoint: "http://127.0.0.1:19000".to_string(),
        access_key: "minioadmin".to_string(),
        prefix: String::new(),
        ..Default::default()
    }
}

#[tokio::test]
#[ignore = "需要本地 mock S3 服务器"]
async fn live_s3_crud() {
    let client = S3Client::new(cfg(), "minioadmin".to_string()).expect("client");

    // put
    client.put_object("live/hello.txt", b"hello live s3").await.expect("put");
    client.put_object("live/dir/nested.txt", b"nested").await.expect("put nested");

    // list（Delimiter=/ 应返回 dir/ 与 hello.txt）
    let page = client
        .list_objects_v2("live/".to_string(), Some("/".to_string()), None, Some(100))
        .await
        .expect("list");
    let names: Vec<String> = page.contents.iter().map(|o| o.key.clone()).collect();
    assert!(names.contains(&"live/hello.txt".to_string()), "contents: {names:?}");
    assert!(page.common_prefixes.contains(&"live/dir/".to_string()), "prefixes: {:?}", page.common_prefixes);

    // get
    let data = client.get_object("live/hello.txt").await.expect("get");
    assert_eq!(data, b"hello live s3");

    // delete
    client.delete_object("live/dir/nested.txt").await.expect("delete nested");
    client.delete_object("live/hello.txt").await.expect("delete");
    client.delete_object("live/dir/").await.expect("delete dir marker");

    // 删除后 list 应为空
    let page = client
        .list_objects_v2("live/".to_string(), Some("/".to_string()), None, Some(100))
        .await
        .expect("list after delete");
    assert!(page.contents.is_empty() && page.common_prefixes.is_empty(), "not empty: {page:?}");
}
