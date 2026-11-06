// A tiny native engine fixture: validates argument handling and writes a real PNG.
package main
import("fmt";"os";"strconv";"image";"image/png";"time")
func main(){
 if len(os.Args)>1 && os.Args[1]=="--help" {fmt.Println("--diffusion-model --list-devices");return}
 if len(os.Args)>1 && os.Args[1]=="--list-devices" {fmt.Println("CUDA0\tTest GPU");fmt.Println("Metal0\tTest GPU");return}
 args:=map[string]string{}
 for i:=1;i+1<len(os.Args);i+=2{args[os.Args[i]]=os.Args[i+1]}
 if args["--prompt"]=="wait-for-cancel" {os.WriteFile(args["--output"]+".pid",[]byte(strconv.Itoa(os.Getpid())),0600);time.Sleep(time.Minute)}
 if source:=args["--ref-image"];source!="" {if _,err:=os.Stat(source);err!=nil{os.Exit(2)}}
 width,_:=strconv.Atoi(args["--width"]);height,_:=strconv.Atoi(args["--height"])
 if width<1||height<1||args["--diffusion-model"]=="" {os.Exit(2)}
 out,err:=os.Create(args["--output"]);if err!=nil{os.Exit(2)}
 if err=png.Encode(out,image.NewRGBA(image.Rect(0,0,width,height)));err!=nil{os.Exit(2)}
 out.Close();fmt.Println("4/4")
}
