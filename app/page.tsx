"use client"

import { useEffect, useRef, useState } from "react";
import { getHint, getProblemNames } from "./server";
import { Container,Text,TextInput,Group,Autocomplete,Select, Button, Stack, Loader, Title, Box, ComboboxItem, Alert, Space, Center, Textarea, Modal, Anchor } from "@mantine/core";
import { useForm } from '@mantine/form';
import { APIError, APIErrorType, AuthResult, HintType, Unauthorized } from "./util";
import { IconExclamationCircleFilled, IconHelpCircleFilled, IconMessageChatbotFilled } from "@tabler/icons-react";
import { exchangeCode, isLoggedIn, logout } from "./auth";

export default function App() {
  const typeNames: Record<HintType, string> = {
    yesNo: "Yes/No", oneWord: "One Word", small: "Small", medium: "Medium", big: "Big"
  };

  const apiErrTypeNames: Record<APIErrorType, string> = {
    failed: "Failed to get completion",
    problemNotFound: "Problem not found",
    editorialNotFound: "Editorial not found",
    refusal: "ChatGPT refused to answer"
  };

  const [res, setRes] = useState<
    null
    | {type: "error", err: string}
    | {type: "unauthorized", err: string}
    | {type: "apiError", err: APIError}
    | ({type: "ok", result: string, tokens: number|null})
    | {type: "loading"}>();
  
  const [authErr, setAuthErr] = useState<Exclude<AuthResult,{type: "success"}>|null>(null);
  const [loggedIn, setLoggedIn] = useState<string|null>(null);

  const askI = useRef(0);

  const [problemNames, setProblemNames] = useState<string[]>([]);
  useEffect(() => {
    getProblemNames().then(x=>setProblemNames(x));
  }, []);

  const form = useForm({
    mode: "uncontrolled",
    initialValues: { probName: "", question: "", type: "yesNo" as HintType },
    validate: {
      probName: (x)=>(/^\d+\w+$/.test(x) ? null : "Problems should be composed of a contest id and a problem index"),
      question: (x)=>x.trim().length>0 ? null : "Your question is empty!",
    }
  });

  let x:React.ReactNode|null=null;
  switch (res?.type) {
    case "loading":
      x=<Center><Loader type="dots" /></Center>;
      break;

    case "ok":
      x=<Alert variant="outline" title="ChatGPT's response" >
        <Group>
          <IconMessageChatbotFilled/>
          <Text size="lg" ff="monospace" >
            {res.result}
          </Text>
        </Group>
        {res.tokens && <Text c="dimmed" size="sm" mt="md" >
          {res.tokens} tokens used
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

  const wrapPromise = (f: ()=>Promise<typeof res>) => {
    const old = ++askI.current;
    const ores=res;
    setRes({type: "loading"});

    f().catch<typeof res>(e => {
      if (e instanceof APIError)
        return {type: "apiError", err: e};
      else if (e instanceof Unauthorized)
        return {type: "unauthorized", err: e.message};
      else return {type:"error", err: `${e}`};
    }).then(x => {
      if (askI.current==old) setRes(x ?? ores);
    })
  };

  const handleSubmit = (values: typeof form.values)=>wrapPromise(async ()=>{
    const match = values.probName.match(/^(\d+)(\w+?)$/)!;
    const res = await getHint(values.type, match[1], match[2], values.question);
    if (res.type!="success") {
      localStorage.setItem("req", JSON.stringify(values));
      setAuthErr(res);
      return null;
    }

    return { ...res, type: "ok" };
  });

  useEffect(() => wrapPromise(async ()=>{
    const req = localStorage.getItem("req");
    let vs:any|null=null;
    if (req!=undefined) {
      vs = JSON.parse(req);
      console.log(vs);
      form.setValues(vs);
    }

    const params = new URLSearchParams(window.location.search);
    const code=params.get("code"), state=params.get("state");
    //so i should probably make this only on post but nextjs makes everything hard D:
    if (code!=undefined && state!=undefined) {
      setLoggedIn(await exchangeCode(code, state));
      window.history.replaceState(null, "", "?");
    } else {
      setLoggedIn(await isLoggedIn());
    }

    if (vs!=null) {
      handleSubmit(vs);
      localStorage.removeItem("req");
    }
    
    return null;
  }), []);

  return (
    <Container pt="lg" >
      <Modal centered opened={authErr!=null} onClose={()=>setAuthErr(null)} title={<Title order={2} >Unauthorized</Title>} withCloseButton >
        <Text>{authErr?.type=="login" ? "You aren't logged in! You must be in the Discord to continue." : "You aren't in the Discord -- you can try logging in again."}</Text>

        <Center mt="lg" >
          <Button onClick={() => {
            if (authErr!=null) window.location.href=authErr?.redirect;
          }} size="lg" >Login with Discord</Button>
        </Center>
      </Modal>

      <Title order={2} my="lg" >Ask about a Codeforces problem</Title>
      <Text my="md" >
        We take data from problem metadata, statement and editorial and feed it into ChatGPT.
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
          key={form.key("question")}
          {...form.getInputProps("question")}
        />

        <Center>
          <Button type="submit" mt="md" disabled={res?.type=="loading"} rightSection={<IconHelpCircleFilled/>} size="xl" >Ask ChatGPT</Button>
        </Center>

      </Stack></form>

      <Space h="lg" />

      {x}

      <Space h="lg" />

      {loggedIn && <Anchor onClick={()=>wrapPromise(()=>logout().then(x=>{
        setLoggedIn(null);
        return null;
      }))} >
        <Group gap="sm" >Logout from <Text fw={600} >@{loggedIn}</Text></Group>
      </Anchor>}
    </Container>
  );
}
