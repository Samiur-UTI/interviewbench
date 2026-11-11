// Minimal declarations for htm (see README.md).
declare const htm: {
  bind<R>(h: (type: any, props: Record<string, any> | null, ...children: any[]) => R): (
    strings: TemplateStringsArray,
    ...values: any[]
  ) => R | R[];
};
export default htm;
