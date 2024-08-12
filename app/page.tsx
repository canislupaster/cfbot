"use client"

import { useEffect, useRef, useState } from "react";
import { getHint, getProblemNames } from "./server";
import { Container,Text,TextInput,Group,Autocomplete,Select, Button, Stack, Loader, Title, Box, ComboboxItem, Alert, Space, Center, Textarea, Modal, Anchor, Image, Code } from "@mantine/core";
import { useForm } from '@mantine/form';
import { APIError, APIErrorType, AuthFailure, HintResult, HintType, resApi, Unauthorized } from "./util";
import { IconBrandDiscordFilled, IconExclamationCircleFilled, IconMessageChatbotFilled, IconRobot } from "@tabler/icons-react";
import { exchangeCode, isLoggedIn, logout } from "./auth";
import what from "./what.svg"
import NextImage from "next/image"
import { CodeHighlight } from "@mantine/code-highlight";
import React from "react";
import { InlineMath, BlockMath } from 'react-katex';

const replacements = [
  {delim: "`", replace: (x: string) => <Code fz="lg" fw={900} >{x}</Code>},
  {delim: "$$", replace: (x: string) => <Box w="100%" ><BlockMath math={x} /></Box>},
  {delim: "$", replace: (x: string) => <InlineMath math={x} />}
];

export default function App() {
  const typeNames: Record<HintType, string> = {
    yesNo: "Yes/No", oneWord: "One Word", small: "Small", medium: "Medium", big: "Big"
  };

  const apiErrTypeNames: Record<APIErrorType, string> = {
    failed: "Failed to get completion",
    problemNotFound: "Problem not found",
    editorialNotFound: "Editorial not found",
    refusal: "The model refused to answer",
    other: "Internal server error"
  };

  type Task = "login"|"completion"|"logout";

  const [res, setRes] = useState<
    null
    | {type: "error", err: string}
    | {type: "unauthorized", err: string}
    | {type: "apiError", err: APIError}
    | ({type: "ok", hint: HintType}&HintResult)
    | {type: "loading", kind: Task}>(null);
  
  const [authErr, setAuthErr] = useState<Exclude<AuthFailure,{type: "success"}>|null>(null);
  const [loggedIn, setLoggedIn] = useState<string|null>(null);

  const askI = useRef(0);

  const [problemNames, setProblemNames] = useState<string[]>([]);
  useEffect(() => {
    resApi(getProblemNames)().then(x=>setProblemNames(x));
  }, []);

  const form = useForm({
    mode: "uncontrolled",
    initialValues: { probName: "", question: "", type: "yesNo" as HintType|null },
    validate: {
      probName: (x)=>(/^\d+\w+$/.test(x) ? null : "Problems should be composed of a contest id and a problem index"),
      type: (x)=>x!=null ? null : "Choose a hint type!"
    }
  });

  let x:React.ReactNode|null=null;
  switch (res?.type) {
    case "loading":
      x=<Center>
        <Stack align="center" >
          <Loader type="dots" />
          <Text>
            {{
              completion: "This might take a minute to scrape data, etc...",
              login: "Logging in...",
              logout: "Logging out..."
            }[res.kind]}
          </Text>
        </Stack>
      </Center>;
      break;

    case "ok":
      const out: ({type: "string", s: string}|{type: "node", x: React.ReactNode})[]=[
        {type: "string", s: res.result}
      ];
      for (const rep of replacements) {
        for (let i=0; i<out.length; i++) {
          const x=out[i];
          if (x.type=="string") {
            let lp=false;
            let arr: typeof out=[];
            let j=0;
            while (x.s.length>0) {
              j = x.s.indexOf(rep.delim, j);
              if (j==-1) break;
              if (j>0 && x.s[j-1]=='\\') {
                console.log(x.s, x.s.slice(j-1), j)
                x.s = `${x.s.slice(0,j-1)}${x.s.slice(j)}`;
                console.log(x.s.slice(j));
                continue;
              }

              console.log(`found ${x.s.slice(0,j)} ${lp}`);

              if (!lp) {
                if (j>0) arr.push({type: "string", s: x.s.slice(0,j)});
              } else {
                arr.push({type: "node", x: rep.replace(x.s.slice(0,j))});
              }

              x.s=x.s.slice(j+rep.delim.length);
              j=0;
              lp=!lp;
            }

            out.splice(i,x.s.length==0 ? 1 : 0,...arr);
            i+=arr.length-(x.s.length==0 ? 1 : 0);
          }
        }
      }

      x=<Alert variant="outline" title={<Title order={4} >{typeNames[res.hint]} Hint</Title>} styles={{
        body: {maxWidth: "100%"}
      }} >
        
        <Box fz="lg" mx={10} >
          <IconMessageChatbotFilled style={{verticalAlign: "sub", marginRight: "0.5rem"}} />

          {out.map((x,i) => 
            x.type=="string"
              ? <Text size="lg" key={i} display="inline" >{x.s}</Text>
              : <React.Fragment key={i} >{x.x}</React.Fragment>
          )}
        </Box>

        {res.code!=null && 
          <CodeHighlight code={res.code.source} mt="md" language={res.code.language} />
        }

        {res.usage && <Text c="dimmed" size="sm" mt="md" >
          {res.usage.tokens} tokens used ({res.usage.cents.toPrecision(3)} ¢ of my money!)
        </Text>}
      </Alert>;
      break;

    case "unauthorized":
    case "error":
      x=<Alert variant="light" color="red" title={res.type=="error" ? "Unknown error" : "Unauthorized"}
        icon={<IconExclamationCircleFilled/>}>

        {res.err}
      </Alert>;
      break;

    case "apiError":
      x=<Alert variant="light" color="red" title={apiErrTypeNames[res.err.type]} icon={<IconExclamationCircleFilled/>}>
        {res.err.message}
      </Alert>;
      break;

    case null: break;
  }

  const wrapPromise = (kind: Task, f: ()=>Promise<typeof res>) => {
    const old = ++askI.current;
    setRes({type: "loading", kind});
    console.log("loading ", askI.current, kind);

    f().catch<typeof res>(e => {
      if (e instanceof APIError)
        return {type: "apiError", err: e};
      else if (e instanceof Unauthorized)
        return {type: "unauthorized", err: e.message};
      else return {type:"error", err: `${e}`};
    }).then(x => {
      console.log("updating to ",x, askI.current, old);
      if (askI.current==old) setRes(x);
    });
  };

  const handleSubmit = (values: typeof form.values)=>wrapPromise("completion", async ()=>{
    const match = values.probName.match(/^(\d+)(\w+?)$/)!;
    const res = await resApi(getHint)(values.type!, match[1], match[2], values.question);
    if (res.type!="success") {
      localStorage.setItem("req", JSON.stringify(values));
      setAuthErr(res);
      return null;
    }

    return { ...res, type: "ok", hint: values.type! };
  });

  useEffect(() => wrapPromise("login", async ()=>{
    const req = localStorage.getItem("req");
    let vs:any|null=null;
    if (req!=undefined) {
      vs = JSON.parse(req);
      form.setValues(vs);
    }

    const params = new URLSearchParams(window.location.search);
    const code=params.get("code"), state=params.get("state");
    //so i should probably make this only on post but nextjs makes everything hard D:
    if (code!=undefined && state!=undefined) {
      window.history.replaceState(null, "", window.location.pathname);
      setLoggedIn(await resApi(exchangeCode)(code, state));
    } else {
      setLoggedIn(await resApi(isLoggedIn)());
    }

    if (vs!=null) {
      handleSubmit(vs);
      localStorage.removeItem("req");
    }
    
    return null;
  }), []);

  return (
    <Container py="lg" maw={700} >
      <Modal centered opened={authErr!=null}
        onClose={()=>setAuthErr(null)}
        title={<Title order={2} >Unauthorized</Title>} withCloseButton >
        {authErr?.type!="notInDiscord" ? "You aren't logged in! You must be in the Discord to continue."
          : <>
            You aren't in the Discord! I've restricted this application to users in the <Anchor href="https://purduecpu.com" target="_blank" >Competitive Programmers Union</Anchor> to save my OpenAI credits. You can <b>join <Anchor href="https://discord.gg/A6twkCcW83" target="_blank" >here</Anchor></b> and refresh, or <b>login again</b>.
          </>}

        <Center mt="lg" >
          <Button onClick={() => {
            if (authErr!=null) window.location.href=authErr?.redirect;
          }} size="lg" ff="heading" leftSection={<IconBrandDiscordFilled/>} >
            Login with Discord
          </Button>
        </Center>
      </Modal>

			<Stack align="center" my="lg" >
        <Image component={NextImage} src={what} alt="icon" w={120} style={{filter: "drop-shadow(0 0 25px black)"}} />
        <Title order={1} >Need a hint?</Title>
      </Stack>
      <Text my="md" >
        We feed data from your Codeforces' problem metadata, statement and editorial into a LLM.
        {loggedIn && <Anchor ml={5} onClick={()=>wrapPromise("logout", ()=>resApi(logout)().then(x=>{
          setLoggedIn(null);
          return null;
        }))} >
          Logout from <b>@{loggedIn}</b>.
        </Anchor>}
      </Text>
      <form
        onSubmit={form.onSubmit(handleSubmit)}
      ><Stack gap="sm" >
        <Group align="start" >
          <Autocomplete
            filter={({options,search})=>(options as ComboboxItem[]).filter(y=>
              y.label.toLowerCase().startsWith(search.toLowerCase())).slice(0,20)}
            label="Problem"
            placeholder="438E"
            key={form.key("probName")}
            {...form.getInputProps("probName")}
            data={problemNames}
          />

          <Select
            label="Hint type"
            defaultValue="yesNo"
            data={Object.entries(typeNames).map(([k, v]) => ({ value: k as HintType, label: v }))}
            key={form.key("type")}
            {...form.getInputProps("type")}
          />
        </Group>

        <Textarea
          size="md"
          label="Question"
          placeholder="Is it FFT?"
          className="w-full"
          autosize minRows={2} maxRows={8}
          key={form.key("question")}
          {...form.getInputProps("question")}
        />

        <Center>
          <Button type="submit" mt="md" disabled={res?.type=="loading"} leftSection={<IconMessageChatbotFilled/>} size="xl" ff="heading" >
            Ask GPT-4o-Mini
          </Button>
        </Center>

      </Stack></form>

      <Space h="lg" />

      {x}
    </Container>
  );
}
