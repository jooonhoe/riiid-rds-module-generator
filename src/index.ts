import * as yaml from 'js-yaml';
import fs from 'fs';
import endent from 'endent';
import * as core from "@actions/core";
import * as exec from "@actions/exec";
import { context, getOctokit } from "@actions/github";

interface InstanceSpec {
  instanceClass: string;
  promotionTier: number;
}

interface VaultSpec {
  path: string;
  databaseNameKey: string;
  usernameKey: string;
  passwordKey: string;
  endpointOutputKey: string;
}

interface SGRuleSpec {
  type?: string;
  description: string;
  fromPort: number;
  toPort: number;
  cidrBlocks: string[];
}

interface Spec {
  region: string;
  project: string;
  component: string;
  env: string;

  engineVersion: string;
  instances: { [key: string]: InstanceSpec };
  vault: VaultSpec;

  extraSGRules: SGRuleSpec[];
}

const configFileTemplate = (doc: Spec) => {
  const { region, env, project, component } = doc;
  return endent`
    terraform {
      required_version = ">= 1.0.0"

      backend "s3" {
        bucket = "riiid-aws-service-${env}-terraform-1.0.0"
        key    = "service/${project}/${component}/rds_generated/tfstate"
        region = "${region}"
      }
    }

    module "const" { source = "../../../../../const" }

    provider "vault" {
      address = module.const.vault.addr
    }

    provider "aws" {
      region = "${region}"
    }` + '\n';
}

const instanceTemplate = (key: string, spec: InstanceSpec) => {
  return endent`
    ${key} = {
      instance_class = "${spec.instanceClass}"
      promotion_tier = ${spec.promotionTier}
    }
  `;
};

const sgRuleTemplate = (sgRule: SGRuleSpec) => {
  return endent`
    {
      type        = "${sgRule.type || 'ingress'}"
      description = "${sgRule.description}"
      from_port   = ${sgRule.fromPort}
      to_port     = ${sgRule.toPort}
      cidr_blocks = [
        ${sgRule.cidrBlocks.map(block => `"${block}",`).join('\n')}
      ]
    },
  `;
};

const extraSGRulesTemplate = (extraSGRules: SGRuleSpec[]) => {
  if (extraSGRules.length === 0) {
    return '';
  }
  return endent`
    extra_sg_rules = [
      ${extraSGRules.map(spec => sgRuleTemplate(spec)).join('\n')}
    ]
  `;
}

const rdsFileTemplate = (doc: Spec) => {
  return endent`
  module "riiid_rds" {
    source = "../../../../../modules/aws/rds"

    project   = "${doc.project}"
    component = "${doc.component}"
    env       = "${doc.env}"

    engine_version = "${doc.engineVersion}"
    
    instances = {
      ${Object.entries(doc.instances).map(([key, instanceSpec]) => instanceTemplate(key, instanceSpec)).join('\n')}
    }

    vault = {
      path                = "${doc.vault.path}"
      database_name_key   = "${doc.vault.databaseNameKey}"
      username_key        = "${doc.vault.usernameKey}"
      password_key        = "${doc.vault.passwordKey}"
      endpoint_output_key = "${doc.vault.endpointOutputKey}"
    }
    ${extraSGRulesTemplate(doc.extraSGRules)}
  }
  ` + '\n';
};

async function installGithubCLI() {
  await exec.exec('curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg');
  await exec.exec('chmod go+r /usr/share/keyrings/githubcli-archive-keyring.gpg');
  await exec.exec('echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" | tee /etc/apt/sources.list.d/github-cli.list > /dev/null');
  await exec.exec('apt update && apt install gh -y');
}

async function run() {
  await installGithubCLI();
  const sha = context.payload['after'];
  await exec.exec(`git config --local user.name 'riiid-ci'`);
  await exec.exec(`git config --local user.email 'inside.serviceaccount@riiid.co'`);
  await exec.exec(`git checkout -b feat/generate-rds-${sha}`);
  const octokit = getOctokit(core.getInput("github-token", { required: true }));
  const compareData = await octokit.rest.repos.compareCommits({
    ...context.repo,
    base: context.payload['before'],
    head: sha
  });

  const detectedFilePaths = (compareData.data.files || [])
    .filter(file => file.status === 'added')
    .filter(file => file.filename.startsWith('infra-requests/rds/'))
    .map(file => file.filename);

  if (detectedFilePaths.length === 0) {
    core.warning("There are no added RDS infra requests.");
    return;
  }

  for (let filePath of detectedFilePaths) {
    core.info(`Detected file: ${filePath}`);
    const spec = yaml.load(await fs.promises.readFile(filePath, 'utf8')) as Spec;
    const targetDir = `./riiid-aws-service-${spec.env}/service/${spec.project}/${spec.component}/rds-generated`;
    if (!fs.existsSync(targetDir)) {
      fs.mkdirSync(targetDir, { recursive: true });
    }
    await fs.promises.writeFile(`${targetDir}/config.tf`, configFileTemplate(spec));
    await fs.promises.writeFile(`${targetDir}/main.tf`, rdsFileTemplate(spec));
    await fs.promises.rm(filePath);
  }

  await exec.exec('git add -A');
  await exec.exec(`git commit -m "feat: generate rds modules from commit ${sha}"`);
  await exec.exec(`gh pr create -t "Generate RDS modules from commit ${sha}" -b "This is an auto generated PR, look at the file changes" -r riiid/infra`);
}

run();
