import { readFileSync } from "fs";
import * as core from "@actions/core";
import { AzureOpenAI } from "openai";
import { Octokit } from "@octokit/rest";
import parseDiff, { Chunk, File } from "parse-diff";
import minimatch from "minimatch";
import { AzureKeyCredential } from "@azure/core-auth";


const OCTOKIT_TOKEN: string = core.getInput("OCTOKIT_TOKEN");
const OPENAI_API_KEY: string = core.getInput("OPENAI_API_KEY");
const OPEN_API_ENDPOINT: string = core.getInput("OPEN_API_ENDPOINT");
const OPENAI_API_MODEL: string = core.getInput("OPENAI_API_MODEL");

const octokit = new Octokit({ auth: OCTOKIT_TOKEN });

// const configuration = new Configuration({
//   apiKey: OPENAI_API_KEY,
// });

// const openai = new OpenAIApi(configuration);

const apiKey = new AzureKeyCredential(OPENAI_API_KEY);
const endpoint = OPEN_API_ENDPOINT;
const apiVersion = "2024-10-21"
const deployment = OPENAI_API_MODEL;

const openai = new AzureOpenAI({ 
    baseURL: endpoint + "/openai",
    apiKey: apiKey.key, 
    apiVersion: apiVersion, 
    deployment: deployment 
});

interface PRDetails {
  owner: string;
  repo: string;
  pull_number: number;
  title: string;
  description: string;
}

async function getPRDetails(): Promise<PRDetails> {
  const { repository, number } = JSON.parse(
    readFileSync(process.env.GITHUB_EVENT_PATH || "", "utf8")
  );
  const prResponse = await octokit.pulls.get({
    owner: repository.owner.login,
    repo: repository.name,
    pull_number: number,
  });
  return {
    owner: repository.owner.login,
    repo: repository.name,
    pull_number: number,
    title: prResponse.data.title ?? "",
    description: prResponse.data.body ?? "",
  };
}

async function getDiff(
  owner: string,
  repo: string,
  pull_number: number
): Promise<string | null> {
  const response = await octokit.pulls.get({
    owner,
    repo,
    pull_number,
    mediaType: { format: "diff" },
  });
  // @ts-expect-error - response.data is a string
  return response.data;
}

async function analyzeCode(
  parsedDiff: File[],
  prDetails: PRDetails
): Promise<Array<{ body: string; path: string; line: number }>> {
  const comments: Array<{ body: string; path: string; line: number }> = [];
  console.log(`Analyzing ${parsedDiff.length} files...`);

  for (const file of parsedDiff) {
    console.log(`Processing file: ${file.to}`);
    if (file.to === "/dev/null") {
      console.log('Skipping deleted file');
      continue;
    }
    
    for (const chunk of file.chunks) {
      const prompt = createPrompt(file, chunk, prDetails);
      console.log('Sending prompt to OpenAI...');
      const aiResponse = await getAIResponse(prompt);
      console.log('AI Response:', aiResponse);
      
      if (aiResponse) {
        const newComments = createComment(file, chunk, aiResponse);
        console.log('Generated comments:', newComments);
        if (newComments) {
          comments.push(...newComments);
        }
      }
    }
  }
  
  console.log(`Total comments generated: ${comments.length}`);
  return comments;
}

async function getBaseAndHeadShas(
  owner: string,
  repo: string,
  pull_number: number
): Promise<{ baseSha: string; headSha: string }> {
  const prResponse = await octokit.pulls.get({
    owner,
    repo,
    pull_number,
  });
  return {
    baseSha: prResponse.data.base.sha,
    headSha: prResponse.data.head.sha,
  };
}

function createPrompt(file: File, chunk: Chunk, prDetails: PRDetails): string {
  return `Your task is to review pull requests. Instructions:
- Provide the response in following JSON format:  [{"lineNumber":  <line_number>, "reviewComment": "<review comment>"}]
- Do not give positive comments or compliments.
- Provide comments and suggestions ONLY if there is something to improve, otherwise return an empty array.
- Write the comment in GitHub Markdown format.
- Use the given description only for the overall context and only comment the code.
- IMPORTANT: NEVER suggest adding comments to the code.

Review the following code diff in the file "${
    file.to
  }" and take the pull request title and description into account when writing the response.
  
Pull request title: ${prDetails.title}
Pull request description:

---
${prDetails.description}
---

Git diff to review:

\`\`\`diff
${chunk.content}
${chunk.changes
  // @ts-expect-error - ln and ln2 exists where needed
  .map((c) => `${c.ln ? c.ln : c.ln2} ${c.content}`)
  .join("\n")}
\`\`\`
`;
}

async function getAIResponse(prompt: string): Promise<Array<{
  lineNumber: string;
  reviewComment: string;
}> | null> {
  const queryConfig = {
    model: OPENAI_API_MODEL,
    temperature: 0.2,
    max_tokens: 700,
    top_p: 1,
    frequency_penalty: 0,
    presence_penalty: 0,
  };

  try {
    console.log('OpenAI Configuration:', {
      baseURL: OPEN_API_ENDPOINT + "/openai",
      apiVersion,
      deployment: OPENAI_API_MODEL,
      model: OPENAI_API_MODEL
    });
    
    const response = await openai.chat.completions.create({
      ...queryConfig,
      messages: [
        {
          role: "system",
          content: prompt,
        },
      ],
    });

    console.log('OpenAI Response:', {
      status: 'success',
      choices: response.choices.length,
      content: response.choices[0].message?.content
    });

    const res = response.choices[0].message?.content?.trim() || "[]";
    return JSON.parse(res);
  } catch (error) {
    console.error("OpenAI Error:", error);
    return null;
  }
}

function createComment(
  file: File,
  chunk: Chunk,
  aiResponses: Array<{
    lineNumber: string;
    reviewComment: string;
  }>
): Array<{ body: string; path: string; line: number }> {
  return aiResponses.flatMap((aiResponse) => {
    if (!file.to) {
      return [];
    }
    return {
      body: "[GPT-REVIEW] " + aiResponse.reviewComment,
      path: file.to,
      line: Number(aiResponse.lineNumber),
    };
  });
}

async function createReviewComment(
  owner: string,
  repo: string,
  pull_number: number,
  comments: Array<{ body: string; path: string; line: number }>
): Promise<void> {
  await octokit.pulls.createReview({
    owner,
    repo,
    pull_number,
    comments,
    event: "COMMENT",
  });
}

async function main() {
  try {
    console.log('Starting PR review process...');
    const prDetails = await getPRDetails();
    console.log('PR Details:', prDetails);

    let diff: string | null;
    const eventData = JSON.parse(
      readFileSync(process.env.GITHUB_EVENT_PATH ?? "", "utf8")
    );
    console.log('Event type:', eventData.action);

    if (eventData.action === "opened") {
      console.log('Getting diff for newly opened PR...');
      diff = await getDiff(
        prDetails.owner,
        prDetails.repo,
        prDetails.pull_number
      );
    } else if (eventData.action === "synchronize") {
      console.log('Getting diff for PR update...');
      const newBaseSha = eventData.before;
      const newHeadSha = eventData.after;
      console.log(`Comparing commits: ${newBaseSha} -> ${newHeadSha}`);

      const response = await octokit.repos.compareCommits({
        headers: {
          accept: "application/vnd.github.v3.diff",
        },
        owner: prDetails.owner,
        repo: prDetails.repo,
        base: newBaseSha,
        head: newHeadSha,
      });

      diff = String(response.data);
    } else {
      console.log("Unsupported event:", process.env.GITHUB_EVENT_NAME);
      return;
    }

    if (!diff) {
      console.log("No diff found");
      return;
    }
    console.log('Diff content length:', diff.length);

    const parsedDiff = parseDiff(diff);
    console.log(`Parsed ${parsedDiff.length} files from diff`);

    const excludePatterns = core
      .getInput("exclude")
      .split(",")
      .map((s) => s.trim());
    console.log('Exclude patterns:', excludePatterns);

    const filteredDiff = parsedDiff.filter((file) => {
      const shouldInclude = !excludePatterns.some((pattern) =>
        minimatch(file.to ?? "", pattern)
      );
      console.log(`File ${file.to}: ${shouldInclude ? 'included' : 'excluded'}`);
      return shouldInclude;
    });
    console.log(`After filtering: ${filteredDiff.length} files to analyze`);

    const comments = await analyzeCode(filteredDiff, prDetails);
    console.log(`Generated ${comments.length} comments`);
    
    if (comments.length > 0) {
      console.log('Posting comments to PR...');
      await createReviewComment(
        prDetails.owner,
        prDetails.repo,
        prDetails.pull_number,
        comments
      );
      console.log('Successfully posted comments');
    } else {
      console.log('No comments to post');
    }
  } catch (error) {
    console.error('Error in main function:', error);
    throw error;
  }
}

main().catch((error) => {
  console.error("Error:", error);
  process.exit(1);
});
