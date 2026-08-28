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
    client
        .put_object("live/hello.txt", b"hello live s3")
        .await
        .expect("put");
    client
        .put_object("live/dir/nested.txt", b"nested")
        .await
        .expect("put nested");

    // list（Delimiter=/ 应返回 dir/ 与 hello.txt）
    let page = client
        .list_objects_v2("live/".to_string(), Some("/".to_string()), None, Some(100))
        .await
        .expect("list");
    let names: Vec<String> = page.contents.iter().map(|o| o.key.clone()).collect();
    assert!(
        names.contains(&"live/hello.txt".to_string()),
        "contents: {names:?}"
    );
    assert!(
        page.common_prefixes.contains(&"live/dir/".to_string()),
        "prefixes: {:?}",
        page.common_prefixes
    );

    // get
    let data = client.get_object("live/hello.txt").await.expect("get");
    assert_eq!(data, b"hello live s3");

    // delete
    client
        .delete_object("live/dir/nested.txt")
        .await
        .expect("delete nested");
    client
        .delete_object("live/hello.txt")
        .await
        .expect("delete");
    client
        .delete_object("live/dir/")
        .await
        .expect("delete dir marker");

    // 删除后 list 应为空
    let page = client
        .list_objects_v2("live/".to_string(), Some("/".to_string()), None, Some(100))
        .await
        .expect("list after delete");
    assert!(
        page.contents.is_empty() && page.common_prefixes.is_empty(),
        "not empty: {page:?}"
    );
}

#[tokio::test]
#[ignore = "需要本地 mock S3 服务器"]
async fn live_multipart_upload() {
    let client = S3Client::new(cfg(), "minioadmin".to_string()).expect("client");

    // 6MB 随机内容，分 1MB 片 → 6 片
    let payload: Vec<u8> = (0..6 * 1024 * 1024).map(|i| (i % 251) as u8).collect();
    let chunk = 1024 * 1024;

    // 分块上传
    let bytes = client
        .upload_object_multipart("live-mp/big.bin", &payload, chunk)
        .await
        .expect("multipart upload");
    assert_eq!(bytes as usize, payload.len());

    // 读回完整内容
    let data = client
        .get_object("live-mp/big.bin")
        .await
        .expect("get full");
    assert_eq!(data.len(), payload.len());
    assert_eq!(data, payload);

    // Range 下载
    let range = client
        .get_object_range("live-mp/big.bin", 1024, Some(2048))
        .await
        .expect("range");
    assert_eq!(range, &payload[1024..2048]);
    let tail = client
        .get_object_range("live-mp/big.bin", payload.len() as u64 - 100, None)
        .await
        .expect("range tail");
    assert_eq!(tail, &payload[payload.len() - 100..]);

    // 清理
    client
        .delete_object("live-mp/big.bin")
        .await
        .expect("cleanup");
}

#[tokio::test]
#[ignore = "需要本地 mock S3 服务器"]
async fn live_multipart_copy() {
    let client = S3Client::new(cfg(), "minioadmin".to_string()).expect("client");

    // 准备源对象（8MB，分 2 片 5MB 复制）
    let payload: Vec<u8> = (0..8 * 1024 * 1024).map(|i| (i % 249) as u8).collect();
    client
        .upload_object_multipart("live-copy/src.bin", &payload, 1024 * 1024)
        .await
        .expect("upload src");

    // 服务端分片复制：8MB 对象，part_size 5MB → 2 片
    let copied = client
        .copy_object_multipart(
            "live-copy/src.bin",
            "live-copy/dst.bin",
            payload.len() as u64,
            5 * 1024 * 1024,
        )
        .await
        .expect("multipart copy");
    assert_eq!(copied as usize, payload.len());

    // 读回校验内容一致
    let data = client
        .get_object("live-copy/dst.bin")
        .await
        .expect("get dst");
    assert_eq!(data, payload);

    // 清理
    client
        .delete_object("live-copy/src.bin")
        .await
        .expect("cleanup src");
    client
        .delete_object("live-copy/dst.bin")
        .await
        .expect("cleanup dst");
}

#[tokio::test]
#[ignore = "需要本地 mock S3 服务器"]
async fn live_multipart_abort() {
    let client = S3Client::new(cfg(), "minioadmin".to_string()).expect("client");

    // 发起分块上传，传 2 片后 abort
    let upload_id = client
        .initiate_multipart_upload("live-mp/abort.bin")
        .await
        .expect("initiate");
    client
        .upload_part("live-mp/abort.bin", 1, &upload_id, &[b'a'; 1024])
        .await
        .expect("part1");
    client
        .upload_part("live-mp/abort.bin", 2, &upload_id, &[b'b'; 1024])
        .await
        .expect("part2");
    client
        .abort_multipart_upload("live-mp/abort.bin", &upload_id)
        .await
        .expect("abort");

    // abort 后对象不应存在
    let status = client.head_object("live-mp/abort.bin").await.expect("head");
    assert_eq!(status, 404);
}
