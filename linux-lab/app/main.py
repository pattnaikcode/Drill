"""Web API for the lab. Run: uvicorn main:app --port 8080"""
import os
from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse
from pydantic import BaseModel
import actions, audit, brain, faults, runner

app = FastAPI(title="OpsPilot Lab")
HERE = os.path.dirname(os.path.abspath(__file__))

class CheckReq(BaseModel):
    name: str
    args: dict = {}

class TypedReq(BaseModel):
    text: str

class ActionReq(BaseModel):
    name: str
    args: dict = {}
    approver: str = ""
    confirmed: bool = False

@app.on_event("startup")
def startup():
    faults.start_app()

@app.get("/")
def index():
    return FileResponse(os.path.join(HERE, "index.html"))

@app.get("/api/catalogue")
def catalogue():
    return {"checks": runner.catalogue(), "actions": {k: v[0] for k, v in actions.ACTIONS.items()}, "faults": list(faults.FAULTS)}

@app.post("/api/check")
def check(r: CheckReq):
    return runner.run_check(r.name, r.args)

@app.post("/api/typed")
def typed(r: TypedReq):
    return runner.run_typed(r.text)

@app.post("/api/fault/{name}")
def fault(name: str):
    return {"message": faults.inject(name)}

@app.post("/api/lab/reset")
def reset():
    return {"message": faults.reset()}

@app.post("/api/investigate")
def investigate():
    return brain.investigate()

@app.post("/api/action")
def action(r: ActionReq):
    try:
        return {"message": actions.execute(r.name, r.args, r.approver.strip(), r.confirmed)}
    except (PermissionError, ValueError) as e:
        raise HTTPException(status_code=403, detail=str(e))

@app.get("/api/audit")
def get_audit():
    return audit.recent()
