const { setupMonocle, setScopes, setScopesBind } = require("../../dist");
setupMonocle("langchain.app");

const { ChatOpenAI, OpenAIEmbeddings } = require("@langchain/openai");
const { formatDocumentsAsString } = require("langchain/util/document");
const { PromptTemplate } = require("@langchain/core/prompts");
const { MemoryVectorStore } = require("langchain/vectorstores/memory");
const {
  RunnableSequence,
  RunnablePassthrough,
} = require("@langchain/core/runnables");
const { StringOutputParser } = require("@langchain/core/output_parsers");


let langchainInvoke = async (msg, model) => {
  const text = "Coffee is a beverage brewed from roasted, ground coffee beans."
  const vectorStore = await MemoryVectorStore.fromTexts(
    [text],
    [{ id: 1 }],
    new OpenAIEmbeddings()
  )
  const retriever = vectorStore.asRetriever();

  const prompt =
    PromptTemplate.fromTemplate(`Answer the question based only on the following context:
{context} .
If you don't know the answer, you can say "I don't know".

Question: {question}`);

  const chain = RunnableSequence.from([
    {
      context: retriever.pipe(formatDocumentsAsString),
      question: new RunnablePassthrough(),
    },
    prompt,
    model,
    new StringOutputParser(),
  ]);

  // set scope for invoking the chain
  const res = await setScopes({ "langchain.scope_test": "1" }, () => {
    return chain.invoke(msg)
  })
  return res;
}

// bind the whole function with a scope
langchainInvoke = setScopesBind({
  "langchain.scope_bind_test": "1"
}, langchainInvoke);

// Only run if this file is being executed directly (not imported)

// `question` defaults to the sample question so tests (which import and call
// main() with no args) stay deterministic. When run from the CLI the question
// is taken from user input via argv instead of only the hardcoded default.
async function main(question = "What is coffee?") {

  try {
    const validModel = new ChatOpenAI({});

    // INVALID API key client
    const invalidModel = new ChatOpenAI({
      openAIApiKey: "INVALID_KEY",
    });

    await langchainInvoke(question, validModel);
    await langchainInvoke(question, invalidModel);
  } catch (e) {
    console.error("Error during langchainInvoke:", e);
  }
}

if (require.main === module) {
  (async () => {
      try {
        // Read the question from user input (CLI args); fall back to the default.
        const question = process.argv.slice(2).join(" ") || undefined;
        await main(question);
      } catch (e) {
        console.error("Error during processing:", e);
      }
      // Wait 5 seconds then exit
      setTimeout(() => {
        console.log("Exiting after 5 seconds...");
        process.exit(0); // force clean exit
      }, 5_000);
    })();
}

module.exports = { main };