#!/bin/sh
set -eu

# Run with an AWS administrator identity, on a dedicated GRT bucket only.
# stdout is the least-privilege policy to attach to the EC2 instance role.
command -v aws >/dev/null 2>&1 || { echo 'Install AWS CLI v2 first.' >&2; exit 1; }
account_id=$(aws sts get-caller-identity --query Account --output text)
bucket=${1:-grt-research-$account_id-apn2}
region=ap-northeast-2
if ! aws s3api head-bucket --bucket "$bucket" --expected-bucket-owner "$account_id" --region "$region" 2>/dev/null; then
  aws s3api create-bucket --bucket "$bucket" --region "$region" \
    --create-bucket-configuration "LocationConstraint=$region" \
    --object-ownership BucketOwnerEnforced >/dev/null
fi
bucket_region=$(aws s3api get-bucket-location --bucket "$bucket" --expected-bucket-owner "$account_id" --region "$region" --query LocationConstraint --output text)
if [ "$bucket_region" != "$region" ]; then
  echo "Bucket must be in $region; no bucket settings changed." >&2
  exit 1
fi
aws s3api put-public-access-block --bucket "$bucket" --expected-bucket-owner "$account_id" --region "$region" \
  --public-access-block-configuration 'BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true'
aws s3api put-bucket-ownership-controls --bucket "$bucket" --expected-bucket-owner "$account_id" --region "$region" \
  --ownership-controls 'Rules=[{ObjectOwnership=BucketOwnerEnforced}]'
aws s3api put-bucket-versioning --bucket "$bucket" --expected-bucket-owner "$account_id" --region "$region" \
  --versioning-configuration Status=Enabled
aws s3api put-bucket-encryption --bucket "$bucket" --expected-bucket-owner "$account_id" --region "$region" \
  --server-side-encryption-configuration '{"Rules":[{"ApplyServerSideEncryptionByDefault":{"SSEAlgorithm":"AES256"}}]}'

cat <<EOF
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": "s3:GetBucketVersioning",
      "Resource": "arn:aws:s3:::$bucket"
    },
    {
      "Effect": "Allow",
      "Action": "s3:ListBucketVersions",
      "Resource": "arn:aws:s3:::$bucket",
      "Condition": {"StringLike": {"s3:prefix": "grt/*"}}
    },
    {
      "Effect": "Allow",
      "Action": ["s3:GetObject", "s3:GetObjectVersion", "s3:PutObject", "s3:DeleteObject", "s3:DeleteObjectVersion"],
      "Resource": "arn:aws:s3:::$bucket/grt/*"
    }
  ]
}
EOF
printf 'Bucket ready: %s (%s). Attach stdout policy to the EC2 instance role.\n' "$bucket" "$region" >&2
printf 'Set STORAGE_DRIVER=s3 AWS_REGION=%s S3_BUCKET=%s S3_PREFIX=grt/ in the server .env.\n' "$region" "$bucket" >&2
