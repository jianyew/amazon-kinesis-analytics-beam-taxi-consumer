import cdk = require('@aws-cdk/core');
import s3 = require('@aws-cdk/aws-s3');
import ec2 = require('@aws-cdk/aws-ec2');
import lambda = require('@aws-cdk/aws-lambda');
import { KinesisReplay } from './amazon-kinesis-replay';
import { GithubBuildPipeline } from './github-build-pipeline';
import { EmrInfrastructure } from './emr-infrastructure';
import kds = require('@aws-cdk/aws-kinesis');
import { KinesisAnalyticsJava } from './kinesis-analytics-infrastructure';
import { FirehoseInfrastructure } from './kinesis-firehose-infrastructure';
import { BeamDashboard } from './cloudwatch-dashboard';
import * as fs from 'fs';
import { SecretValue, CfnParameter, Duration } from '@aws-cdk/core';

export interface StackProps extends cdk.StackProps {
  build?: boolean,
  demoInfrastructure?: boolean,
  completeInfrastructure?: boolean
}

export class CdkStack extends cdk.Stack {
  constructor(scope: cdk.Construct, id: string, props: StackProps) {
    super(scope, id, props);

    this.templateOptions.description = 'Creates sample Apache Beam pipeline that can be deployed to Kinesis Data Analytics for Java Applications and Amazon EMR (amazon-kinesis-analytics-beam-taxi-consumer)'

    const keyName = new cdk.CfnParameter(this, 'KeyName', {
      type: 'AWS::EC2::KeyPair::KeyName'
    }).valueAsString;

    const vpc = new ec2.Vpc(this, 'VPC', {
      cidr: "10.0.0.0/16",
      subnetConfiguration: [
        {
          cidrMask: 24,
          name: 'public',
          subnetType: ec2.SubnetType.PUBLIC,
        }
      ]
    });

    const bucket = new s3.Bucket(this, 'Bucket', {
      versioned: true
    });

    new cdk.CfnOutput(this, 'S3Bucket', { value: bucket.bucketName });

    const oauthToken = SecretValue.cfnParameter(
      new CfnParameter(this, 'GithubOauthToken', {
        type: 'String',
        noEcho: true,
        description: `Create a token with 'repo' and 'admin:repo_hook' permissions here https://github.com/settings/tokens`
      })
    );

    const githubUsername = new CfnParameter(this, 'GithubUser', {
      type: 'String',
      default: 'aws-samples',
      description: `Your github username (you need to fork the two repositories https://github.com/aws-samples/amazon-kinesis-analytics-beam-taxi-consumer and https://github.com/aws-samples/amazon-kinesis-replay)`
    })

    const consumerBuild = new GithubBuildPipeline(this, 'BeamTaxiConsumerBuildPipeline', {
      bucket: bucket,
      region: this.region,
      accountId: this.account,
      oauthToken: oauthToken,
      repo: 'amazon-kinesis-analytics-beam-taxi-consumer',
      owner: githubUsername.valueAsString,
      artifactPrefix: 'beam-taxi-count'
    });
    

    if (! (props.demoInfrastructure || props.completeInfrastructure)) {
      return;
    }


    const lambdaSource = fs.readFileSync('lambda/add-approximate-arrival-time.js').toString();

    const enrichEvents = new lambda.Function(this, 'EnrichEventsLambda', {
      runtime: lambda.Runtime.NODEJS_8_10,
      code: lambda.Code.inline(lambdaSource),
      timeout: Duration.seconds(60),
      handler: 'index.handler'
    });
    
    new KinesisReplay(this, 'KinesisReplayInfrastructure', {
      bucket: bucket,
      keyName: keyName,
      region: this.region,
      accountId: this.account,
      oauthToken: oauthToken,
      owner: githubUsername.valueAsString,
      vpc: vpc
    });

    new EmrInfrastructure(this, 'EmrInfrastructure', {
      bucket: bucket,
      keyName: keyName,
      region: this.region,
      vpc: vpc
    });


    if (! props.completeInfrastructure) {
      new cdk.CfnOutput(this, 'KinesisReplayCommand', { value: `java -jar amazon-kinesis-replay-*.jar -streamRegion ${this.region} -objectPrefix artifacts/kinesis-analytics-taxi-consumer/taxi-trips-partitioned.json.lz4/dropoff_year=2018/ -speedup 720 -streamName beam-summit` });
      new cdk.CfnOutput(this, 'StartFlinkApplication', { value: `flink run -p 8 beam-taxi-count-*.jar --runner=FlinkRunner --inputS3Pattern=s3://${bucket.bucketName}/kinesis-stream-data/*/*/*/*/* --inputStreamName=beam-summit --awsRegion=${this.region} --source=s3 --outputBoroughs=true` });  

      return;
    }

    const stream = new kds.Stream(this, 'InputStream', {
      shardCount: 4
    });

    const dashboard = new BeamDashboard(this, 'Dashboard', {
      inputStream: stream,
      dashboardName: cdk.Aws.STACK_NAME
    });

    new FirehoseInfrastructure(this, 'FirehoseInfrastructure', {
      bucket: bucket,
      inputStream: stream,
      lambda: enrichEvents,
      buildSuccessWaitCondition: consumerBuild.buildSuccessWaitCondition
    });

    new KinesisAnalyticsJava(this, 'FlinkInfrastructure', {
      applicationName: cdk.Aws.STACK_NAME,
      dashboard: dashboard,
      bucket: bucket,
      inputStream: stream,
      accountId: this.account,
      region: this.region,
      buildSuccessWaitCondition: consumerBuild.buildSuccessWaitCondition,
    });

    new cdk.CfnOutput(this, 'KinesisReplayCommand', { value: `java -jar amazon-kinesis-replay-*.jar -streamRegion ${this.region} -streamName ${stream.streamName} -objectPrefix artifacts/kinesis-analytics-taxi-consumer/taxi-trips-partitioned.json.lz4/dropoff_year=2018/ -speedup 720` });
    new cdk.CfnOutput(this, 'StartFlinkApplication', { value: `flink run -p 8 beam-taxi-count-*.jar --runner=FlinkRunner --inputS3Pattern=s3://${bucket.bucketName}/kinesis-stream-data/*/*/*/*/* --awsRegion=${this.region} --inputStreamName=${stream.streamName} --source=s3 --outputBoroughs=true` });
  }
}
